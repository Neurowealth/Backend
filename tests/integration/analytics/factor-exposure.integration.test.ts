/**
 * #352 — /analytics/factor-exposure route integration test.
 *
 * Mounts the REAL analytics router on a minimal Express app with only auth and
 * the DB mocked, so a request travels through the real validators, the real
 * DB-glue service (factorExposureService) and the real pure cores
 * (benchmark.ts + factorExposure.ts).
 *
 * The portfolio fixture is engineered to TRACK the market factor, so the
 * full-window summary should come out near beta ≈ 1 and R² ≈ 1 — validating
 * the whole pipeline end-to-end, not just routing.
 */
const ownerUserId = '11111111-1111-4111-8111-111111111111'

import request from 'supertest'
import express from 'express'

jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = ownerUserId
    req.auth = { userId: ownerUserId, walletAddress: 'GWALLET_OWNER' }
    next()
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
  requestLogger: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/config/env', () => ({
  config: {
    attribution: { benchmarkProtocols: [] },
  },
}))

import db from '../../../src/db'
import analyticsRouter from '../../../src/routes/analytics'

const mockDb = db as any

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-17T00:00:00Z')
const YEAR_FRACTION_PER_DAY = 1 / 365.25

/**
 * Build protocolRate rows where APY varies day-to-day (so the market factor has
 * variance — required for a meaningful beta), and matching YieldSnapshot rows
 * where the portfolio value compounds at exactly the market's daily return so
 * the portfolio TRACKS the market (beta → 1, R² → 1).
 */
function buildFixtureConfig(days: number): {
  protocolRates: any[]
  snapshots: any[]
  expectedBetaCloseTo: number
} {
  const apyByDay: number[] = []
  for (let d = 0; d <= days; d++) apyByDay.push(5 + (d % 5)) // 5..9 cycling

  const protocolRates: any[] = []
  for (let d = 0; d <= days; d++) {
    const fetchedAt = new Date(NOW.getTime() - (days - d) * DAY)
    for (const name of ['Blend', 'Luma']) {
      protocolRates.push({
        protocolName: name,
        assetSymbol: 'USDC',
        supplyApy: apyByDay[d],
        tvl: 1000,
        fetchedAt,
      })
    }
  }

  // market daily return on day d = mean of the two protocols' daily fraction
  const marketRet = (d: number) => (apyByDay[d] / 100) * YEAR_FRACTION_PER_DAY

  const snapshots: any[] = []
  let value = 1000
  for (let d = 0; d <= days; d++) {
    if (d > 0) value = value * (1 + marketRet(d))
    snapshots.push({
      positionId: `pos-${d}`,
      snapshotAt: new Date(NOW.getTime() - (days - d) * DAY + 12 * 3600_000),
      principalAmount: value.toFixed(6),
      yieldAmount: '0',
    })
  }

  return { protocolRates, snapshots, expectedBetaCloseTo: 1 }
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/analytics', analyticsRouter)
  return app
}

function setupDb(days: number) {
  const cfg = buildFixtureConfig(days)
  mockDb.protocolRate = {
    findMany: jest.fn().mockResolvedValue(cfg.protocolRates),
  }
  mockDb.yieldSnapshot = {
    findMany: jest
      .fn()
      .mockImplementation(({ orderBy }: any) =>
        Promise.resolve(
          orderBy?.snapshotAt === 'asc' ? cfg.snapshots : cfg.snapshots
        )
      ),
  }
  // position is used by other analytics routes but not by factor-exposure; stub defensively.
  mockDb.position = { findMany: jest.fn().mockResolvedValue([]) }
}

describe('GET /api/v1/analytics/factor-exposure', () => {
  it('returns a tracked portfolio with summary beta ≈ 1 and rolling windows', async () => {
    setupDb(90)
    const res = await request(buildApp()).get(
      `/api/v1/analytics/factor-exposure?window=90d&rollingWindow=30d`
    )

    expect(res.status).toBe(200)
    expect(res.body.userId).toBe(ownerUserId)
    expect(res.body.insufficientHistory).toBe(false)
    expect(res.body.sampleCount).toBeGreaterThan(30)

    // Summary: portfolio tracks the market -> beta ≈ 1, R² ≈ 1.
    expect(res.body.summary).not.toBeNull()
    expect(Math.abs(res.body.summary.beta - 1)).toBeLessThan(0.15)
    expect(res.body.summary.rSquared).toBeGreaterThan(0.7)

    // Rolling: 90 samples, 30d non-overlapping -> ~3 windows.
    expect(res.body.rolling.length).toBeGreaterThanOrEqual(2)

    // Benchmark universe + fixed caveat travel with the response.
    expect(res.body.benchmark.universeSize).toBe(2)
    expect(res.body.benchmark.weighting).toBe('equal')
    expect(res.body.caveats).toContainEqual(
      expect.stringContaining('not a traded index')
    )

    // Determinism: an input-snapshot hash is present and stable.
    expect(res.body.inputHash).toMatch(/^sha256:/)
  })

  it('honours window and rollingWindow query params', async () => {
    setupDb(90)
    const res = await request(buildApp()).get(
      `/api/v1/analytics/factor-exposure?window=30d&rollingWindow=7d`
    )
    expect(res.status).toBe(200)
    expect(res.body.window).toBe('30d')
    expect(res.body.rollingWindow).toBe('7d')
  })

  it('rejects rollingWindow >= window (400)', async () => {
    setupDb(90)
    const res = await request(buildApp()).get(
      `/api/v1/analytics/factor-exposure?window=30d&rollingWindow=30d`
    )
    expect(res.status).toBe(400)
  })

  it('rejects an invalid rollingWindow enum (400)', async () => {
    setupDb(90)
    const res = await request(buildApp()).get(
      `/api/v1/analytics/factor-exposure?window=90d&rollingWindow=999d`
    )
    expect(res.status).toBe(400)
  })

  it('flags insufficientHistory when the portfolio has too little data', async () => {
    setupDb(5) // only 6 days -> far below MIN_FACTOR_SAMPLES
    const res = await request(buildApp()).get(
      `/api/v1/analytics/factor-exposure?window=30d&rollingWindow=7d`
    )
    expect(res.status).toBe(200)
    expect(res.body.insufficientHistory).toBe(true)
    expect(res.body.summary).toBeNull()
  })
})
