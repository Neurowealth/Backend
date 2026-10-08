const mockUserId = '11111111-1111-4111-8111-111111111111'

import request from 'supertest'
import express from 'express'

jest.mock('../../src/middleware/authenticate', () => {
  const requireAuth = jest.fn((req: any, _res: any, next: any) => {
    req.userId = mockUserId
    req.auth = {
      userId: mockUserId,
      walletAddress: 'GWALLET_USER_1',
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

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const plans = new Map<string, any>()
let planSeq = 0

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    recurringWithdrawalPlan: {
      create: jest.fn(async ({ data }: any) => {
        const id =
          mockUserId.slice(0, -12) + String(++planSeq).padStart(12, '0')
        const plan = {
          ...data,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastRunAt: null,
          lastRunStatus: null,
          status: data.status ?? 'ACTIVE',
        }
        plans.set(id, plan)
        return plan
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const result = []
        for (const p of plans.values()) {
          if (where?.userId && p.userId !== where.userId) continue
          if (where?.status && p.status !== where.status) continue
          result.push(p)
        }
        return result
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return plans.get(where.id) ?? null
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const plan = plans.get(where.id)
        if (!plan) throw new Error('Plan not found')
        Object.assign(plan, data)
        plan.updatedAt = new Date()
        return plan
      }),
    },
    transaction: {
      findFirst: jest.fn(async () => null),
    },
    linkedExternalWallet: {
      findFirst: jest.fn(async () => null),
    },
    complianceCase: {
      findFirst: jest.fn(async () => null),
    },
    savingsGoal: {
      findMany: jest.fn(async () => []),
    },
    position: {
      findMany: jest.fn(async () => []),
    },
  },
}))

import recurringWithdrawalRouter from '../../src/routes/recurring-withdrawals'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/recurring-withdrawals', recurringWithdrawalRouter)
  return app
}

describe('Recurring Withdrawals Integration Tests', () => {
  beforeEach(() => {
    plans.clear()
    planSeq = 0
  })

  it('POST /api/v1/recurring-withdrawals creates a new plan when confirmed', async () => {
    const app = buildApp()

    const res = await request(app).post('/api/v1/recurring-withdrawals').send({
      userId: mockUserId,
      destinationAddress: 'GDESTINATION1234567890',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 100,
      cadence: 'MONTHLY',
      confirmed: true,
    })

    expect(res.status).toBe(201)
    expect(res.body.plan).toBeDefined()
    expect(res.body.plan.userId).toBe(mockUserId)
    expect(res.body.plan.amountMode).toBe('FIXED')
  })

  it('POST /api/v1/recurring-withdrawals fails when confirmed is false or omitted', async () => {
    const app = buildApp()

    const res = await request(app).post('/api/v1/recurring-withdrawals').send({
      userId: mockUserId,
      destinationAddress: 'GDESTINATION1234567890',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 100,
      cadence: 'MONTHLY',
    })

    expect(res.status).toBe(400)
  })

  it('GET /api/v1/recurring-withdrawals lists user plans', async () => {
    const app = buildApp()

    await request(app).post('/api/v1/recurring-withdrawals').send({
      userId: mockUserId,
      destinationAddress: 'GDESTINATION1234567890',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 50,
      cadence: 'WEEKLY',
      confirmed: true,
    })

    const res = await request(app).get('/api/v1/recurring-withdrawals')

    expect(res.status).toBe(200)
    expect(res.body.plans).toHaveLength(1)
  })

  it('DELETE /api/v1/recurring-withdrawals/:id cancels plan', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/recurring-withdrawals')
      .send({
        userId: mockUserId,
        destinationAddress: 'GDESTINATION1234567890',
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        amount: 50,
        cadence: 'WEEKLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    const deleteRes = await request(app).delete(
      `/api/v1/recurring-withdrawals/${planId}`
    )

    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.plan.status).toBe('CANCELLED')
  })
})
