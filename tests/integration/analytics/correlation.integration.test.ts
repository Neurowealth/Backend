/**
 * #348 — /analytics/correlation route integration test.
 *
 * Mounts the REAL analytics router on a minimal Express app with only auth and
 * the DB mocked, so a request travels through the real validators, the real
 * DB-glue service (correlationService) and the real pure core (correlation.ts).
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

import db from '../../../src/db'
import analyticsRouter from '../../../src/routes/analytics'

const mockDb = db as any

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-17T00:00:00Z')

function rateRows(spec: Record<string, number>, days = 60) {
  const rows: any[] = []
  for (let d = 0; d < days; d++) {
    const fetchedAt = new Date(NOW.getTime() - (days - 1 - d) * DAY)
    for (const [protocolName, base] of Object.entries(spec)) {
      rows.push({
        protocolName,
        assetSymbol: 'USDC',
        supplyApy: base + (d % 5), // common small swing per day
        fetchedAt,
      })
    }
  }
  return rows
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/analytics', analyticsRouter)
  return app
}

function setupDb(overrides: { positions?: any[] } = {}) {
  mockDb.protocolRate = {
    findMany: jest
      .fn()
      .mockResolvedValue(rateRows({ Blend: 5, Luma: 4, Aqua: 6 })),
  }
  mockDb.position = {
    findMany: jest.fn().mockResolvedValue(
      overrides.positions ?? [
        { protocolName: 'Blend', currentValue: '8000' },
        { protocolName: 'Luma', currentValue: '2000' },
      ]
    ),
  }
}

beforeEach(() => setupDb())

describe('GET /api/v1/analytics/correlation', () => {
  it('returns a correlation matrix and a 0-100 diversification score', async () => {
    const res = await request(buildApp()).get(
      `/api/v1/analytics/correlation?window=90d`
    )

    expect(res.status).toBe(200)
    expect(res.body.computed).toBe(true)
    expect(res.body.userId).toBe(ownerUserId)
    expect(res.body.protocols).toEqual(['Aqua', 'Blend', 'Luma'])
    expect(res.body.correlation).toHaveLength(3)
    // Symmetric 1-diagonal matrix, all values bounded in [-1,1].
    for (let i = 0; i < 3; i++) {
      expect(res.body.correlation[i][i]).toBe(1)
      for (let j = 0; j < 3; j++) {
        expect(res.body.correlation[i][j]).toBeGreaterThanOrEqual(-1)
        expect(res.body.correlation[i][j]).toBeLessThanOrEqual(1)
      }
    }
    expect(res.body.averageCorrelation).not.toBeNull()
    expect(res.body.diversificationScore).toBeGreaterThanOrEqual(0)
    expect(res.body.diversificationScore).toBeLessThanOrEqual(100)
    // The mandatory caveat must travel with every correlation response.
    expect(res.body.caveat).toEqual(expect.stringContaining('APY'))
  })

  it('honours the requested window', async () => {
    const res = await request(buildApp()).get(
      `/api/v1/analytics/correlation?window=30d`
    )
    expect(res.status).toBe(200)
    expect(res.body.window).toBe('30d')
  })

  it('returns computed:false when fewer than 2 protocols have history', async () => {
    mockDb.protocolRate = {
      findMany: jest.fn().mockResolvedValue(rateRows({ Blend: 5 }, 60)),
    }
    const res = await request(buildApp()).get(
      `/api/v1/analytics/correlation?window=90d`
    )

    expect(res.status).toBe(200)
    expect(res.body.computed).toBe(false)
    expect(res.body.diversificationScore).toBeNull()
    expect(res.body.averageCorrelation).toBeNull()
  })

  it('validates the window query', async () => {
    const res = await request(buildApp()).get(
      `/api/v1/analytics/correlation?window=999d`
    )
    expect(res.status).toBe(400)
  })
})
