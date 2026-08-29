/**
 * #349 — /analytics/yield-breakdown route integration test.
 *
 * Mounts the REAL analytics router on a minimal Express app with only auth and
 * the DB mocked, so a request travels through the real route, the real DB-glue
 * service (yieldCompositionService) and the real pure core (yieldComposition).
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

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/analytics', require('../../../src/routes/analytics').default)
  return app
}

function setupDb(overrides: { rates?: any[]; held?: any[] } = {}) {
  mockDb.position = {
    findMany: jest
      .fn()
      .mockResolvedValue(
        overrides.held ?? [{ protocolName: 'Blend' }, { protocolName: 'Luma' }]
      ),
  }
  mockDb.protocolRate = {
    findMany: jest.fn().mockResolvedValue(
      overrides.rates ?? [
        {
          protocolName: 'Blend',
          assetSymbol: 'USDC',
          network: 'TESTNET',
          supplyApy: 8,
          baseApy: 3,
          incentiveApy: 5,
          rewardTokens: [{ symbol: 'BLND' }],
          fetchedAt: new Date(),
        },
        {
          protocolName: 'Luma',
          assetSymbol: 'USDC',
          network: 'TESTNET',
          supplyApy: 6,
          baseApy: null,
          incentiveApy: null,
          rewardTokens: null,
          fetchedAt: new Date(),
        },
      ]
    ),
  }
}

describe('GET /api/v1/analytics/yield-breakdown', () => {
  beforeEach(() => setupDb())

  it('returns the base/incentive split, incentive share and effective APY', async () => {
    const res = await request(buildApp()).get(
      `/api/v1/analytics/yield-breakdown`
    )

    expect(res.status).toBe(200)
    expect(res.body.userId).toBe(ownerUserId)
    expect(res.body.protocols).toHaveLength(2)

    const blend = res.body.protocols.find((p: any) => p.protocol === 'Blend')
    expect(blend.baseApy).toBe(3)
    expect(blend.incentiveApy).toBe(5)
    // share = 5/(3+5) = 0.625
    expect(blend.incentiveShare).toBeCloseTo(0.625, 6)
    // effective = 3 + 5×(1−0.15) = 7.25
    expect(blend.effectiveApy).toBeCloseTo(7.25, 6)
    expect(blend.rewardTokens).toEqual([{ symbol: 'BLND' }])

    // No split → effective falls back to supplyApy and share is null.
    const luma = res.body.protocols.find((p: any) => p.protocol === 'Luma')
    expect(luma.incentiveShare).toBeNull()
    expect(luma.effectiveApy).toBe(6)

    expect(res.body.caveat).toEqual(expect.stringContaining('haircut'))
    // Consumption flag is off by default (existing behavior preserved).
    expect(res.body.effectiveApyEnabled).toBe(false)
  })

  it('falls back to all protocols when the user holds none', async () => {
    setupDb({ held: [] })
    const res = await request(buildApp()).get(
      `/api/v1/analytics/yield-breakdown`
    )
    expect(res.status).toBe(200)
    expect(res.body.protocols.length).toBeGreaterThanOrEqual(2)
    // With no held protocols the where-clause is unfiltered (in: [] would return
    // nothing), so the service must pass undefined — assert a real query hit.
    const findMany = mockDb.protocolRate.findMany
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: expect.arrayContaining(['protocolName']),
      })
    )
  })
})
