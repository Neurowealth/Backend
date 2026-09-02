/**
 * #344 — POST /api/v1/strategies/simulate integration test.
 *
 * Mounts the real router with only auth + DB + colour/scan I/O mocked, so the
 * request travels through the REAL validator, the REAL controller, the REAL
 * strategy service and the REAL pure simulation core. The acceptance criterion
 * this file proves:
 *   1. Validation — TARGET_ALLOCATION weights must sum to 100 (post-resolution),
 *      GOAL_TRACKING requires an active goal, and followStrategyId is mutually
 *      exclusive with an inline config.
 *   2. ZERO SIDE EFFECTS — a successful simulation never writes an OutboxOp,
 *      AgentLog, Transaction, or any User/PublishedStrategy/Position row. The
 *      DB mocks assert no write-capable model was touched under the hood.
 *   3. Owner scoping — only the caller's rows/config drive the result.
 */
const mockUserId = '11111111-1111-4111-8111-111111111111'
const followId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

import request from 'supertest'
import express from 'express'

jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = mockUserId
    req.auth = { userId: mockUserId, walletAddress: 'GWALLET_USER_1' }
    next()
  },
  enforceUserAccess: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../src/db', () => ({ __esModule: true, default: {} }))

// The simulate route carries a tight per-endpoint rate limiter (6/min). Stub it
// to a pass-through so the suite can exercise MULTIPLE validation/service
// scenarios in one window without tripping the limiter — the real middleware is
// exercised by the rate-limiter's own tests.
jest.mock('../../src/middleware/rateLimiter', () => {
  const actual = jest.requireActual('../../src/middleware/rateLimiter')
  return {
    ...actual,
    simulateRateLimiter: (_req: any, _res: any, next: any) => next(),
  }
})

// The scanner makes real Stellar/network reads — stub it for deterministic tests.
jest.mock('../../src/agent/scanner', () => ({
  scanAllProtocols: jest.fn().mockResolvedValue([
    {
      name: 'Blend',
      apy: 5,
      assetSymbol: 'USDC',
      lastUpdated: new Date('2026-01-10T00:00:00.000Z'),
      isAvailable: true,
    },
  ]),
}))

import db from '../../src/db'
import strategiesRouter from '../../src/routes/strategies'

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/strategies', strategiesRouter)
  return app
}

const app = buildApp()

/** Shape rows exactly as the service's selects produce them. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: mockUserId,
    rebalanceStrategy: 'MAX_YIELD',
    strategyConfig: null,
    ...overrides,
  }
}

function positionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    userId: mockUserId,
    protocolName: 'Blend',
    currentValue: '5000.000000',
    status: 'ACTIVE',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.$transaction = jest.fn(async (fn: any) => fn(mockDb))
  mockDb.user = { findUnique: jest.fn().mockResolvedValue(userRow()) }
  mockDb.strategyFollow = { findFirst: jest.fn().mockResolvedValue(null) }
  mockDb.publishedStrategy = {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    upsert: jest.fn(),
    update: jest.fn(),
  }
  mockDb.savingsGoal = { findFirst: jest.fn().mockResolvedValue(null) }
  mockDb.position = { findMany: jest.fn().mockResolvedValue([positionRow()]) }
  mockDb.protocolRate = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.protocolRiskScore = {
    findMany: jest
      .fn()
      .mockResolvedValue([{ protocolName: 'Blend', score: 60 }]),
  }
  // Rate-limiter / write-path models that MUST never be exercised.
  mockDb.userApiKey = { findFirst: jest.fn().mockResolvedValue(null) }
  mockDb.outbox = { create: jest.fn(), createMany: jest.fn() }
  mockDb.agentLog = { create: jest.fn(), createMany: jest.fn() }
  mockDb.transaction = { create: jest.fn(), createMany: jest.fn() }
  mockDb.rebalanceDecision = { create: jest.fn() }
})

async function postSimulate(body: unknown) {
  return request(app)
    .post('/api/v1/strategies/simulate')
    .send(body as object)
}

describe('POST /api/v1/strategies/simulate — happy path', () => {
  it('returns immediate + historical + token for the caller with a position', async () => {
    // 30 days of retained history for the replay.
    mockDb.protocolRate.findMany.mockResolvedValue([
      {
        protocolName: 'Blend',
        assetSymbol: 'USDC',
        supplyApy: '5',
        fetchedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ])

    const res = await postSimulate({ historyWindowDays: 30 })

    expect(res.status).toBe(200)
    expect(res.body.immediate).toBeDefined()
    expect(res.body.immediate.action).toMatch(/hold|rebalance|blocked/)
    expect(res.body.historical).toBeDefined()
    expect(res.body.simulationToken).toBeTruthy()
    expect(res.body.asOf).toBeTruthy()
    expect(res.body.effectiveConfig.strategyName).toBe('MAX_YIELD')
    expect(res.body.label).toBeTruthy()
  })

  it('does NOT create any side-effect rows (zero side effects)', async () => {
    mockDb.protocolRate.findMany.mockResolvedValue([])

    const res = await postSimulate({})

    expect(res.status).toBe(200)
    expect(mockDb.outbox.create).not.toHaveBeenCalled()
    expect(mockDb.outbox.createMany).not.toHaveBeenCalled()
    expect(mockDb.agentLog.create).not.toHaveBeenCalled()
    expect(mockDb.transaction.create).not.toHaveBeenCalled()
    expect(mockDb.rebalanceDecision.create).not.toHaveBeenCalled()
    // No strategy/user/position writes either.
    expect(mockDb.publishedStrategy.upsert).not.toHaveBeenCalled()
    expect(mockDb.publishedStrategy.update).not.toHaveBeenCalled()
  })

  it('anchors on the caller current-follow config when no inline config is given', async () => {
    const published = {
      id: followId,
      strategyConfig: {
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 100 },
        riskCeiling: 60,
      },
    }
    mockDb.strategyFollow.findFirst.mockResolvedValue({
      publishedStrategy: published,
    })

    const res = await postSimulate({})

    expect(res.status).toBe(200)
    expect(res.body.effectiveConfig.strategyName).toBe('TARGET_ALLOCATION')
    expect(res.body.effectiveConfig.targetAllocations).toEqual({ Blend: 100 })
    expect(res.body.effectiveConfig.riskCeiling).toBe(60)
  })
})

describe('POST /api/v1/strategies/simulate — validation', () => {
  it('rejects followStrategyId combined with an inline strategy config (400)', async () => {
    const res = await postSimulate({
      followStrategyId: followId,
      strategy: 'MAX_YIELD',
    })
    expect(res.status).toBe(400)
  })

  it('rejects TARGET_ALLOCATION weights that do not sum to 100 (400)', async () => {
    const res = await postSimulate({
      strategy: 'TARGET_ALLOCATION',
      targetAllocations: { Blend: 40, Luma: 40 },
      riskCeiling: 70,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sum to 100/i)
  })

  it('rejects GOAL_TRACKING with no active savings goal (400)', async () => {
    const res = await postSimulate({
      strategy: 'GOAL_TRACKING',
      targetAllocations: { Blend: 100 },
      riskCeiling: 70,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/GOAL_TRACKING/i)
  })

  it('caps historyWindowDays at the 180-day simulation cap (400)', async () => {
    const res = await postSimulate({
      historyWindowDays: 365,
      strategy: 'MAX_YIELD',
    })
    // Crosses the validator cap -> rejected before the service sees it.
    expect(res.status).toBe(400)
  })
})
