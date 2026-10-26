import express from 'express'
import request from 'supertest'
import db from '../../src/db'
import goalsRouter from '../../src/routes/goals'
import {
  recordContributionAttribution,
  recordYieldAttribution,
  recordWithdrawalAttribution,
} from '../../src/goals/service'
import { executeRebalanceIfNeeded } from '../../src/agent/router'

jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    const uid =
      req.headers['x-test-user'] || '11111111-1111-4111-8111-111111111111'
    req.userId = uid
    req.auth = { userId: uid }
    next()
  },
  enforceUserAccess: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/middleware/apiKeyAuth', () => ({
  requireScope: () => (_req: any, _res: any, next: any) => next(),
  guardScopes: () => undefined,
}))

jest.mock('../../src/middleware/idempotency', () => ({
  idempotent: () => (_req: any, _res: any, next: any) => next(),
}))

const mockScanAllProtocols = jest.fn()
const mockGetCurrentOnChainApy = jest.fn()
jest.mock('../../src/agent/scanner', () => ({
  scanAllProtocols: (...args: unknown[]) => mockScanAllProtocols(...args),
  getCurrentOnChainApy: (...args: unknown[]) =>
    mockGetCurrentOnChainApy(...args),
}))

jest.mock('../../src/outbox/dispatcher', () => ({
  dispatchInBackground: jest.fn(),
}))

const goalsStore: any[] = []
const allocationsStore: any[] = []
let positionsStore: any[] = []

jest.mock('../../src/db', () => {
  const client: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        goalFundingMode: 'SEQUENTIAL',
      })),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    position: {
      findMany: jest.fn(async ({ where }: any) =>
        positionsStore.filter(
          (p) => !where?.userId || p.userId === where.userId
        )
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          positionsStore.find((p) => p.id === where.id) ?? null
      ),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    yieldSnapshot: {
      findMany: jest.fn().mockResolvedValue([{ apy: 8 }]),
    },
    protocolRiskScore: {
      findMany: jest.fn().mockResolvedValue([
        { protocolName: 'Blend', score: 90 },
        { protocolName: 'Luma', score: 85 },
        { protocolName: 'DegenPool', score: 50 },
      ]),
    },
    protocolLiquiditySnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    savingsGoal: {
      create: jest.fn(async ({ data }: any) => {
        const now = new Date()
        const row = {
          id: `00000000-0000-4000-8000-${String(goalsStore.length + 1).padStart(12, '0')}`,
          createdAt: now,
          updatedAt: now,
          priority: 100,
          allocationWeight: 1,
          fundingMode: 'SEQUENTIAL',
          includeExternalHoldings: false,
          ...data,
        }
        goalsStore.push(row)
        return row
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return goalsStore.filter((g) => {
          if (where?.userId && g.userId !== where.userId) return false
          if (where?.status && g.status !== where.status) return false
          if (
            where?.includeExternalHoldings !== undefined &&
            Boolean(g.includeExternalHoldings) !== where.includeExternalHoldings
          ) {
            return false
          }
          return true
        })
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          goalsStore.find((g) => {
            if (where?.userId && g.userId !== where.userId) return false
            if (where?.status && g.status !== where.status) return false
            return true
          }) ?? null
        )
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return goalsStore.find((g) => g.id === where.id) ?? null
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = goalsStore.findIndex((g) => g.id === where.id)
        if (idx === -1) throw new Error('Goal not found')
        goalsStore[idx] = {
          ...goalsStore[idx],
          ...data,
          updatedAt: new Date(),
        }
        return goalsStore[idx]
      }),
    },
    goalAllocation: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `alloc-${allocationsStore.length + 1}`,
          createdAt: new Date(),
          ...data,
        }
        allocationsStore.push(row)
        return row
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const ids: string[] | undefined = where?.goalId?.in
        return allocationsStore.filter((a) =>
          ids ? ids.includes(a.goalId) : a.goalId === where?.goalId
        )
      }),
    },
    agentLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
    },
    rebalanceDecision: {
      create: jest.fn().mockResolvedValue({ id: 'dec-1' }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    auditPayloadHash: {
      create: jest.fn().mockResolvedValue({ id: 'hash-1' }),
    },
    transaction: {
      create: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    },
    outboxOp: {
      create: jest.fn().mockResolvedValue({ id: 'op-1' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  }
  client.$transaction = async (fn: any) => fn(client)
  return { __esModule: true, default: client }
})

jest.mock('../../src/jobs/riskMetadataStaleness', () => ({
  getStaleProtocolNames: jest.fn().mockResolvedValue(new Set()),
  applyStalenessPenalty: (score: number) => score,
}))

describe('Multiple Concurrent Goals with Priority-Weighted Allocation (#358)', () => {
  const userId = '11111111-1111-4111-8111-111111111111'
  const app = express()
  app.use(express.json())
  app.use('/api/v1/goals', goalsRouter)

  beforeEach(() => {
    jest.clearAllMocks()
    goalsStore.length = 0
    allocationsStore.length = 0
    positionsStore = [
      { id: 'pos-1', userId, status: 'ACTIVE', currentValue: 1000 },
    ]
    mockScanAllProtocols.mockResolvedValue([
      {
        name: 'Luma',
        apy: 18,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
      {
        name: 'Blend',
        apy: 4,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
    ])
    mockGetCurrentOnChainApy.mockResolvedValue(4)
  })

  it('creates multiple concurrent ACTIVE goals, attributes contributions/yield/withdrawals, lists progress, and reassigns capital while preserving the sum invariant', async () => {
    const targetDate1 = new Date(Date.now() + 180 * 86_400_000).toISOString()
    const targetDate2 = new Date(Date.now() + 365 * 86_400_000).toISOString()

    // Create high-priority emergency fund (priority 10, target 500)
    const create1 = await request(app).post('/api/v1/goals').send({
      targetAmount: 500,
      startingAmount: 0,
      targetDate: targetDate1,
      priority: 10,
      allocationWeight: 2,
      fundingMode: 'SEQUENTIAL',
    })
    expect(create1.status).toBe(201)
    const goal1Id = create1.body.goal.id

    // Create lower-priority vacation fund (priority 50, target 800)
    const create2 = await request(app).post('/api/v1/goals').send({
      targetAmount: 800,
      startingAmount: 0,
      targetDate: targetDate2,
      priority: 50,
      allocationWeight: 1,
      fundingMode: 'SEQUENTIAL',
    })
    expect(create2.status).toBe(201)
    const goal2Id = create2.body.goal.id

    // Attribute a 700 deposit sequentially: 500 fills goal1 (ACHIEVED!), 200 cascades to goal2
    await recordContributionAttribution({
      userId,
      amount: 700,
      sourceType: 'DEPOSIT',
      sourceId: 'tx-dep-1',
      mode: 'SEQUENTIAL',
      database: db as any,
    })

    // Attribute 50 yield: goal1 is ACHIEVED so it stops receiving new attribution; goal2 gets all 50
    await recordYieldAttribution({
      userId,
      yieldAmount: 50,
      sourceId: 'snap-1',
      database: db as any,
    })

    // GET /api/v1/goals returns both goals with attributed currentAmount, portfolioShare, and unallocated
    const listRes = await request(app).get('/api/v1/goals')
    expect(listRes.status).toBe(200)
    expect(listRes.body.goals).toHaveLength(2)
    expect(listRes.body.goals[0].goal.id).toBe(goal1Id)
    expect(listRes.body.goals[0].currentAmount).toBe(500)
    expect(listRes.body.goals[0].progress.status).toBe('ACHIEVED')
    expect(listRes.body.goals[1].goal.id).toBe(goal2Id)
    expect(listRes.body.goals[1].currentAmount).toBe(250)
    expect(listRes.body.totalAttributed).toBe(750)
    expect(listRes.body.unallocated).toBe(250) // 1000 portfolio - 750 attributed

    // PUT /api/v1/goals/:id updates priority, allocationWeight, fundingMode on active goal2
    const putRes = await request(app)
      .put(`/api/v1/goals/${goal2Id}`)
      .send({ priority: 25, allocationWeight: 3, fundingMode: 'WEIGHTED' })
    expect(putRes.status).toBe(200)
    expect(putRes.body.goal.priority).toBe(25)
    expect(putRes.body.goal.allocationWeight).toBe(3)
    expect(putRes.body.goal.fundingMode).toBe('WEIGHTED')

    // Reassigning more than goal2 holds (250) is rejected with available balance in error
    const badReassign = await request(app)
      .post(`/api/v1/goals/${goal2Id}/reassign`)
      .send({ toGoalId: goal1Id, amount: 400 })
    expect(badReassign.status).toBe(400)
    expect(badReassign.body.message || badReassign.body.error).toContain('250')

    // Valid reassignment of 100 from goal1 to goal2 preserves total attributed sum (750)
    const okReassign = await request(app)
      .post(`/api/v1/goals/${goal1Id}/reassign`)
      .send({ toGoalId: goal2Id, amount: 100 })
    expect(okReassign.status).toBe(200)
    expect(okReassign.body.fromGoalCurrentAmount).toBe(400)
    expect(okReassign.body.toGoalCurrentAmount).toBe(350)

    const afterReassign = await request(app).get('/api/v1/goals')
    expect(afterReassign.body.totalAttributed).toBe(750)

    // Withdrawal of 200 reduces from lowest-priority goal (goal2, priority 25) before goal1 (priority 10)
    await recordWithdrawalAttribution({
      userId,
      withdrawalAmount: 200,
      sourceId: 'tx-wd-1',
      database: db as any,
    })

    const afterWithdrawal = await request(app).get('/api/v1/goals')
    expect(afterWithdrawal.body.goals[0].currentAmount).toBe(400)
    expect(afterWithdrawal.body.goals[1].currentAmount).toBe(150)
    expect(afterWithdrawal.body.totalAttributed).toBe(550)
  })

  it('agent selects the binding goal (highest requiredApy) and stricter riskCeiling across concurrent active goals', async () => {
    const oneYearOut = new Date(Date.now() + 365 * 86_400_000)

    // Goal A: easy target (needs ~5% APY), strict riskCeiling = 80
    await (db as any).savingsGoal.create({
      data: {
        userId,
        targetAmount: 1050,
        startingAmount: 1000,
        targetDate: oneYearOut,
        priority: 10,
        riskCeiling: 80,
        status: 'ACTIVE',
      },
    })

    // Goal B: harder target (needs ~15% APY -> binding!), looser riskCeiling = 50
    await (db as any).savingsGoal.create({
      data: {
        userId,
        targetAmount: 1150,
        startingAmount: 1000,
        targetDate: oneYearOut,
        priority: 20,
        riskCeiling: 50,
        status: 'ACTIVE',
      },
    })

    // DegenPool has 30% APY but score 50 (< stricter ceiling 80). Luma has 18% APY and score 85 (>= 80).
    mockScanAllProtocols.mockResolvedValue([
      {
        name: 'DegenPool',
        apy: 30,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
      {
        name: 'Luma',
        apy: 18,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
      {
        name: 'Blend',
        apy: 4,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
    ])

    const rebalance = await executeRebalanceIfNeeded(
      'Blend',
      [{ id: 'pos-1', amount: '1000000000000000000000', userId }],
      undefined,
      [{ userId, strategyName: 'MAX_YIELD' }]
    )

    expect(rebalance).not.toBeNull()
    // Must pick Luma (18% APY, score 85 >= 80) and reject DegenPool (score 50 < stricter ceiling 80)
    expect(rebalance!.toProtocol).toBe('Luma')
  })
})
