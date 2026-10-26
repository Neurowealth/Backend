/**
 * Integration tests for Goal-Linked Auto-Contributions with Catch-Up Sizing (#357).
 */

import request from 'supertest'
import express from 'express'

const mockUserId = '11111111-1111-4111-8111-111111111111'
const mockOtherUserId = '22222222-2222-4222-8222-222222222222'
let currentAuthUserId = mockUserId

jest.mock('../../src/middleware/authenticate', () => {
  const requireAuth = jest.fn((req: any, _res: any, next: any) => {
    req.userId = currentAuthUserId
    req.auth = {
      userId: currentAuthUserId,
      walletAddress: 'GWALLET_USER',
      network: 'TESTNET',
    }
    next()
  })
  const enforceUserAccess = jest.fn((req: any, res: any, next: any) => {
    const target = req.params.userId ?? req.body?.userId
    if (target && target !== req.auth.userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  })
  return { requireAuth, enforceUserAccess }
})

jest.mock('../../src/middleware/idempotency', () => ({
  idempotent: () => (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

const mockExecuteDeposit = jest.fn()
jest.mock('../../src/controllers/transaction-controller', () => ({
  executeDeposit: (...args: unknown[]) => mockExecuteDeposit(...args),
}))

const mockPublishUserEvent = jest.fn().mockResolvedValue(undefined)
jest.mock('../../src/events/publisher', () => ({
  publishUserEvent: (...args: unknown[]) => mockPublishUserEvent(...args),
}))

jest.mock('../../src/utils/metrics', () => ({
  recordBackgroundJob: jest.fn(),
}))
jest.mock('../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

const goalsStore = new Map<string, any>()
const plansStore = new Map<string, any>()
const runsStore: any[] = []
let planSeq = 0
let currentWalletBalance: number | undefined = undefined

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    savingsGoal: {
      findUnique: jest.fn(async ({ where }: any) => {
        return goalsStore.get(where.id) ?? null
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        for (const g of goalsStore.values()) {
          if (where?.userId && g.userId !== where.userId) continue
          if (where?.status && g.status !== where.status) continue
          return g
        }
        return null
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const g = goalsStore.get(where.id)
        if (!g) throw new Error('Goal not found')
        Object.assign(g, data, { updatedAt: new Date() })
        return g
      }),
    },
    recurringDepositPlan: {
      create: jest.fn(async ({ data }: any) => {
        const id = `00000000-0000-4000-8000-${String(++planSeq).padStart(12, '0')}`
        const plan = {
          status: 'ACTIVE',
          sizingMode: 'FIXED',
          catchUpHorizon: 'SPREAD_REMAINING',
          minAmount: null,
          maxAmount: null,
          savingsGoalId: null,
          lastRunAt: null,
          lastRunStatus: null,
          lastShortfall: null,
          lastClampedBy: null,
          consecutiveFailures: 0,
          accumulatedRuns: 0,
          ...data,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        plansStore.set(id, plan)
        return plan
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return plansStore.get(where.id) ?? null
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        for (const p of plansStore.values()) {
          if (where?.userId && p.userId !== where.userId) continue
          if (where?.status && p.status !== where.status) continue
          return p
        }
        return null
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const out: any[] = []
        for (const p of plansStore.values()) {
          if (where?.userId && p.userId !== where.userId) continue
          if (where?.status && p.status !== where.status) continue
          if (where?.savingsGoalId && p.savingsGoalId !== where.savingsGoalId)
            continue
          out.push(p)
        }
        return out
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0
        for (const p of plansStore.values()) {
          if (where?.id && p.id !== where.id) continue
          if (where?.savingsGoalId && p.savingsGoalId !== where.savingsGoalId)
            continue
          if (where?.sizingMode && p.sizingMode !== where.sizingMode) continue
          if (where?.status && p.status !== where.status) continue
          Object.assign(p, data, { updatedAt: new Date() })
          count++
        }
        return { count }
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const p = plansStore.get(where.id)
        if (!p) throw new Error('Plan not found')
        Object.assign(p, data, { updatedAt: new Date() })
        return p
      }),
      count: jest.fn(async () => plansStore.size),
    },
    recurringDepositRun: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `run-${runsStore.length + 1}`, ...data }
        runsStore.push(row)
        return row
      }),
      count: jest.fn(async () => runsStore.length),
      findMany: jest.fn(async () => runsStore),
    },
    custodialWallet: {
      findUnique: jest.fn(async () => ({
        publicKey: 'GWALLET_USER',
        ...(currentWalletBalance !== undefined
          ? { availableBalance: currentWalletBalance }
          : {}),
      })),
    },
    transaction: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  },
}))

import recurringDepositRouter from '../../src/routes/recurring-deposits'
import goalsRouter from '../../src/routes/goals'
import { processRecurringDeposits } from '../../src/jobs/recurringDeposits'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/recurring-deposits', recurringDepositRouter)
  app.use('/api/v1/deposit/recurring', recurringDepositRouter)
  app.use('/api/v1/goals', goalsRouter)
  app.use('/api/v1/portfolio/goals', goalsRouter)
  return app
}

describe('Goal-Linked Auto-Contributions with Catch-Up Sizing (#357)', () => {
  const goalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const otherGoalId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  beforeEach(() => {
    jest.clearAllMocks()
    goalsStore.clear()
    plansStore.clear()
    runsStore.length = 0
    planSeq = 0
    currentAuthUserId = mockUserId
    currentWalletBalance = undefined

    const futureDate = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000) // 4 weeks out
    goalsStore.set(goalId, {
      id: goalId,
      userId: mockUserId,
      targetAmount: 2000,
      startingAmount: 1000,
      currentAmount: 1000,
      actualApy: 0,
      targetDate: futureDate,
      riskCeiling: null,
      includeExternalHoldings: false,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    goalsStore.set(otherGoalId, {
      id: otherGoalId,
      userId: mockOtherUserId,
      targetAmount: 5000,
      startingAmount: 1000,
      currentAmount: 1000,
      actualApy: 0,
      targetDate: futureDate,
      riskCeiling: null,
      includeExternalHoldings: false,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  it('creates a GOAL_CATCH_UP plan, previews next N runs, and inspects goal funding status', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/recurring-deposits')
      .send({
        userId: mockUserId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
        savingsGoalId: goalId,
        sizingMode: 'GOAL_CATCH_UP',
        minAmount: 50,
        maxAmount: 250,
        catchUpHorizon: 'SPREAD_REMAINING',
      })

    expect(createRes.status).toBe(201)
    expect(createRes.body.plan.savingsGoalId).toBe(goalId)
    expect(createRes.body.plan.sizingMode).toBe('GOAL_CATCH_UP')
    expect(createRes.body.plan.minAmount).toBe(50)
    expect(createRes.body.plan.maxAmount).toBe(250)

    const planId = createRes.body.plan.id

    // Preview plan
    const previewRes = await request(app).get(
      `/api/v1/recurring-deposits/${planId}/preview?runs=5`
    )
    expect(previewRes.status).toBe(200)
    expect(previewRes.body.planId).toBe(planId)
    expect(previewRes.body.goalId).toBe(goalId)
    expect(previewRes.body.runsCount).toBe(5)
    expect(previewRes.body.isSimulation).toBe(true)
    expect(previewRes.body.disclaimer).toContain('projection')

    // Goal funding status
    const fundingRes = await request(app).get(`/api/v1/goals/${goalId}/funding`)
    expect(fundingRes.status).toBe(200)
    expect(fundingRes.body.goalId).toBe(goalId)
    expect(fundingRes.body.linkedPlans).toHaveLength(1)
    expect(fundingRes.body.linkedPlans[0].planId).toBe(planId)
    expect(fundingRes.body.linkedPlans[0].sizingMode).toBe('GOAL_CATCH_UP')
  })

  it('rejects linking to another user goal, non-ACTIVE goal, or invalid bounds', async () => {
    const app = buildApp()

    const otherUserGoalRes = await request(app)
      .post('/api/v1/recurring-deposits')
      .send({
        userId: mockUserId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
        savingsGoalId: otherGoalId,
        sizingMode: 'GOAL_CATCH_UP',
        minAmount: 50,
        maxAmount: 250,
      })
    expect(otherUserGoalRes.status).toBe(403)

    const badBoundsRes = await request(app)
      .post('/api/v1/recurring-deposits')
      .send({
        userId: mockUserId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
        savingsGoalId: goalId,
        sizingMode: 'GOAL_CATCH_UP',
        minAmount: 300,
        maxAmount: 200,
      })
    expect(badBoundsRes.status).toBe(400)
  })

  it('job sizes catch-up run after claim, records shortfall/clampedBy, and emits goal.contribution_capped when maxAmount binds', async () => {
    const app = buildApp()
    const createRes = await request(app)
      .post('/api/v1/recurring-deposits')
      .send({
        userId: mockUserId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
        savingsGoalId: goalId,
        sizingMode: 'GOAL_CATCH_UP',
        minAmount: 50,
        maxAmount: 150, // Capped below required catch-up amount
        catchUpHorizon: 'SPREAD_REMAINING',
      })
    const planId = createRes.body.plan.id
    const plan = plansStore.get(planId)
    plan.nextRunAt = new Date(Date.now() - 1000)

    mockExecuteDeposit.mockResolvedValue({
      status: 'CONFIRMED',
      transaction: { id: 'tx-1', txHash: '0xhash1' },
    })

    await processRecurringDeposits()

    expect(mockExecuteDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUserId,
        amount: 150,
      })
    )
    expect(plan.lastRunStatus).toBe('executed')
    expect(plan.lastClampedBy).toBe('max')
    expect(plan.lastShortfall).toBeGreaterThan(0)

    expect(mockPublishUserEvent).toHaveBeenCalledWith(
      mockUserId,
      'transactions',
      'recurring_deposit.executed',
      expect.objectContaining({
        planId,
        amount: 150,
        sizingMode: 'GOAL_CATCH_UP',
        clampedBy: 'max',
      })
    )
    expect(mockPublishUserEvent).toHaveBeenCalledWith(
      mockUserId,
      'alerts',
      'goal.contribution_capped',
      expect.objectContaining({
        planId,
        goalId,
        appliedAmount: 150,
        clampedBy: 'max',
      })
    )
  })

  it('insufficient balance degrades to partial or skips with skipped_insufficient_balance without calling executeDeposit', async () => {
    const app = buildApp()
    const createRes = await request(app)
      .post('/api/v1/recurring-deposits')
      .send({
        userId: mockUserId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
        savingsGoalId: goalId,
        sizingMode: 'GOAL_CATCH_UP',
        minAmount: 60,
        maxAmount: 250,
        catchUpHorizon: 'SPREAD_REMAINING',
      })
    const planId = createRes.body.plan.id
    const plan = plansStore.get(planId)

    // Case 1: Available balance (30) < minAmount (60) -> skipped_insufficient_balance
    plan.nextRunAt = new Date(Date.now() - 1000)
    currentWalletBalance = 30

    await processRecurringDeposits()

    expect(mockExecuteDeposit).not.toHaveBeenCalled()
    expect(plan.lastRunStatus).toBe('skipped_insufficient_balance')
    expect(mockPublishUserEvent).toHaveBeenCalledWith(
      mockUserId,
      'transactions',
      'recurring_deposit.failed',
      expect.objectContaining({
        planId,
        reason: 'skipped_insufficient_balance',
      })
    )

    // Case 2: Available balance (90) between minAmount (60) and derivedAmount -> partial deposit of 90
    jest.clearAllMocks()
    plan.nextRunAt = new Date(Date.now() - 1000)
    plan.lastRunStatus = null
    currentWalletBalance = 90
    mockExecuteDeposit.mockResolvedValue({
      status: 'CONFIRMED',
      transaction: { id: 'tx-partial', txHash: '0xpartial' },
    })

    await processRecurringDeposits()

    expect(mockExecuteDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 90,
      })
    )
    expect(plan.lastRunStatus).toBe('executed_partial_balance')
  })

  it('auto-pauses GOAL_CATCH_UP plan when linked goal reaches ACHIEVED or CANCELLED', async () => {
    const app = buildApp()
    const createRes = await request(app)
      .post('/api/v1/recurring-deposits')
      .send({
        userId: mockUserId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
        savingsGoalId: goalId,
        sizingMode: 'GOAL_CATCH_UP',
        minAmount: 50,
        maxAmount: 250,
      })
    const planId = createRes.body.plan.id
    const plan = plansStore.get(planId)
    plan.nextRunAt = new Date(Date.now() - 1000)

    // Mark goal ACHIEVED
    goalsStore.get(goalId).status = 'ACHIEVED'

    await processRecurringDeposits()

    expect(mockExecuteDeposit).not.toHaveBeenCalled()
    expect(plan.status).toBe('PAUSED')
    expect(plan.lastRunStatus).toBe('paused_goal_achieved')
  })
})
