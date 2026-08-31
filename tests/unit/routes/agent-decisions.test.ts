process.env.NODE_ENV = 'test'

import express from 'express'
import request from 'supertest'
import { Request, Response, NextFunction } from 'express'
import { Network } from '@prisma/client'
import agentDecisionsRouter from '../../../src/routes/agent-decisions'

const mockFindMany = jest.fn()
const mockCount = jest.fn()
const mockFindFirst = jest.fn()
const mockOutboxFindMany = jest.fn()
const mockOutboxFindUnique = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    rebalanceDecision: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      count: (...a: unknown[]) => mockCount(...a),
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
    },
    outboxOp: {
      findMany: (...a: unknown[]) => mockOutboxFindMany(...a),
      findUnique: (...a: unknown[]) => mockOutboxFindUnique(...a),
    },
  },
}))

jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers?.authorization) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      walletAddress: 'GTEST',
      network: Network.MAINNET,
    }
    next()
  },
}))

const app = express()
app.use(express.json())
app.use('/decisions', agentDecisionsRouter)

function authHeader() {
  return { Authorization: 'Bearer test-token' }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockOutboxFindMany.mockResolvedValue([])
  mockOutboxFindUnique.mockResolvedValue(null)
})

describe('GET /decisions', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/decisions')
    expect(res.status).toBe(401)
  })

  it('lists own decisions, strips affectedUserIds', async () => {
    mockCount.mockResolvedValue(1)
    mockFindMany.mockResolvedValue([
      {
        id: 'dec-1',
        correlationId: 'corr-1',
        batchKey: 'Blend:MAX_YIELD:none',
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        outcome: 'REBALANCED',
        blockedReason: null,
        strategyName: 'MAX_YIELD',
        strategyIsFollowed: false,
        followedStrategyId: null,
        thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
        currentApy: { toNumber: () => 3 },
        chosenApy: { toNumber: () => 8 },
        rawImprovement: { toNumber: () => 5 },
        estCostPercent: { toNumber: () => 0.1 },
        netImprovement: { toNumber: () => 4.9 },
        candidates: [
          { protocol: 'Luma', apy: 8, eligible: true, rejectionReason: null },
        ],
        rationale: 'test',
        affectedUserIds: ['user-1', 'user-2'],
        affectedPositions: 2,
        outboxOpId: null,
        heldSince: null,
        lastEvaluatedAt: null,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      },
    ])

    const res = await request(app).get('/decisions').set(authHeader())
    expect(res.status).toBe(200)
    expect(res.body.decisions[0]).not.toHaveProperty('affectedUserIds')
    expect(res.body.decisions[0].id).toBe('dec-1')
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ affectedUserIds: { has: 'user-1' } }),
      })
    )
  })

  it('filters by outcome', async () => {
    mockCount.mockResolvedValue(0)
    mockFindMany.mockResolvedValue([])
    const res = await request(app)
      .get('/decisions?outcome=HELD')
      .set(authHeader())
    expect(res.status).toBe(200)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ outcome: 'HELD' }),
      })
    )
  })
})

describe('GET /decisions/:id', () => {
  it('returns 404 when not visible', async () => {
    mockFindFirst.mockResolvedValue(null)
    const res = await request(app)
      .get('/decisions/00000000-0000-4000-a000-000000000000')
      .set(authHeader())
    expect(res.status).toBe(404)
  })

  it('returns decision when visible and strips affectedUserIds', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'dec-1',
      correlationId: 'corr-1',
      batchKey: 'Blend:MAX_YIELD:none',
      fromProtocol: 'Blend',
      toProtocol: null,
      outcome: 'HELD',
      blockedReason: null,
      strategyName: 'MAX_YIELD',
      strategyIsFollowed: false,
      followedStrategyId: null,
      thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
      currentApy: { toNumber: () => 3 },
      chosenApy: null,
      rawImprovement: null,
      estCostPercent: null,
      netImprovement: null,
      candidates: [],
      rationale: 'hold',
      affectedUserIds: ['user-1'],
      affectedPositions: 1,
      outboxOpId: null,
      heldSince: new Date(),
      lastEvaluatedAt: new Date(),
      createdAt: new Date(),
    })
    const res = await request(app)
      .get('/decisions/00000000-0000-4000-a000-000000000000')
      .set(authHeader())
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('affectedUserIds')
    expect(res.body.id).toBe('dec-1')
  })
})
