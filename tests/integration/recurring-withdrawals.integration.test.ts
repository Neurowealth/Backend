const mockUserId = '11111111-1111-4111-8111-111111111111'
const mockOtherUserId = '22222222-2222-4222-8222-222222222222'

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

jest.mock('../../src/middleware/apiKeyAuth', () => ({
  requireScope: () => (_req: any, _res: any, next: any) => next(),
}))

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

jest.mock('../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

const plans = new Map<string, any>()
let planSeq = 0

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    recurringWithdrawalPlan: {
      create: jest.fn(async ({ data }: any) => {
        const id = `plan-w-${++planSeq}`
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
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        const result = []
        for (const p of plans.values()) {
          if (where?.userId && p.userId !== where.userId) continue
          if (where?.status && p.status !== where.status) continue
          result.push(p)
        }
        if (orderBy?.createdAt === 'desc') result.reverse()
        return result
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return plans.get(where.id) ?? null
      }),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ where, data }: any) => {
        const plan = plans.get(where.id)
        if (!plan) throw new Error('Plan not found')
        Object.assign(plan, data)
        plan.updatedAt = new Date()
        return plan
      }),
    },
    position: {
      findMany: jest.fn(async ({ where }: any) => [
        {
          id: 'pos-1',
          userId: where.userId,
          assetSymbol: where.assetSymbol ?? 'USDC',
          currentValue: 1000,
          yieldEarned: 50,
          status: 'ACTIVE',
        },
      ]),
      findUnique: jest.fn(async () => null),
    },
    savingsGoal: {
      findFirst: jest.fn(async () => null),
    },
    outboxOp: {
      findMany: jest.fn(async () => []),
    },
  },
}))

import recurringWithdrawalRouter from '../../src/routes/recurring-withdrawals'

declare const describe: any
declare const it: any
declare const expect: any
declare const beforeEach: any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/recurring-withdrawals', recurringWithdrawalRouter)
  return app
}

describe('E2E integration — recurring withdrawals', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    plans.clear()
    planSeq = 0

    const authModule = require('../../src/middleware/authenticate')
    authModule.requireAuth.mockImplementation(
      (req: any, _res: any, next: any) => {
        req.userId = mockUserId
        req.auth = {
          userId: mockUserId,
          walletAddress: 'GWALLET_USER_1',
          network: 'TESTNET',
        }
        next()
      }
    )
  })

  it('POST creates plan, GET lists it, GET :id views it, and DELETE cancels it', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/recurring-withdrawals')
      .send({
        userId: mockUserId,
        destinationAddress:
          'GDESTINATION12345678901234567890123456789012345678901234',
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        amount: 75,
        cadence: 'WEEKLY',
        confirmed: true,
      })

    expect(createRes.status).toBe(201)
    expect(createRes.body.plan).toBeDefined()
    expect(createRes.body.plan.userId).toBe(mockUserId)
    expect(createRes.body.plan.amount).toBe(75)
    expect(createRes.body.plan.amountMode).toBe('FIXED')
    expect(createRes.body.plan.status).toBe('ACTIVE')
    expect(createRes.body.plan.nextRunAt).toBeDefined()

    const planId = createRes.body.plan.id

    const listRes = await request(app).get(
      `/api/v1/recurring-withdrawals/by-user/${mockUserId}`
    )
    expect(listRes.status).toBe(200)
    expect(listRes.body.plans).toHaveLength(1)
    expect(listRes.body.plans[0].id).toBe(planId)

    const getRes = await request(app).get(
      `/api/v1/recurring-withdrawals/${planId}`
    )
    expect(getRes.status).toBe(200)
    expect(getRes.body.plan.id).toBe(planId)

    const deleteRes = await request(app).delete(
      `/api/v1/recurring-withdrawals/${planId}`
    )
    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.plan.status).toBe('CANCELLED')
  })

  it('PATCH updates plan and flags destination address change as risk signal', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/recurring-withdrawals')
      .send({
        userId: mockUserId,
        destinationAddress:
          'GORIGINALDESTINATION123456789012345678901234567890123456',
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        amount: 100,
        cadence: 'MONTHLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    const patchRes = await request(app)
      .patch(`/api/v1/recurring-withdrawals/${planId}`)
      .send({
        destinationAddress:
          'GNEWDESTINATIONADDRESS1234567890123456789012345678901234',
        amount: 150,
      })

    expect(patchRes.status).toBe(200)
    expect(patchRes.body.plan.destinationAddress).toBe(
      'GNEWDESTINATIONADDRESS1234567890123456789012345678901234'
    )
    expect(patchRes.body.plan.amount).toBe(150)
    expect(patchRes.body.plan.lastRunStatus).toBe('held_new_destination')
  })

  it('preview computes projected run amounts and statuses', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/recurring-withdrawals')
      .send({
        userId: mockUserId,
        destinationAddress:
          'GDESTINATION12345678901234567890123456789012345678901234',
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        amount: 200,
        cadence: 'WEEKLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    const previewRes = await request(app).get(
      `/api/v1/recurring-withdrawals/${planId}/preview`
    )

    expect(previewRes.status).toBe(200)
    expect(previewRes.body.preview).toBeDefined()
    expect(previewRes.body.preview.planId).toBe(planId)
    expect(previewRes.body.preview.totalBalance).toBe(1000)
    expect(previewRes.body.preview.projectedAmount).toBe(200)
    expect(previewRes.body.preview.isNewDestination).toBe(true)
    expect(previewRes.body.preview.status).toBe('WOULD_HOLD_NEW_DESTINATION')
  })

  it('rejects creation when confirmed: true is omitted', async () => {
    const app = buildApp()

    const res = await request(app).post('/api/v1/recurring-withdrawals').send({
      userId: mockUserId,
      destinationAddress:
        'GDESTINATION12345678901234567890123456789012345678901234',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 50,
      cadence: 'WEEKLY',
    })

    expect(res.status).toBe(400)
  })

  it('forbids cross-user plan updates', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/recurring-withdrawals')
      .send({
        userId: mockUserId,
        destinationAddress:
          'GDESTINATION12345678901234567890123456789012345678901234',
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        amount: 50,
        cadence: 'WEEKLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    const authModule = require('../../src/middleware/authenticate')
    authModule.requireAuth.mockImplementation(
      (req: any, _res: any, next: any) => {
        req.userId = mockOtherUserId
        req.auth = {
          userId: mockOtherUserId,
          walletAddress: 'GWALLET_USER_2',
          network: 'TESTNET',
        }
        next()
      }
    )

    const patchRes = await request(app)
      .patch(`/api/v1/recurring-withdrawals/${planId}`)
      .send({ status: 'PAUSED' })

    expect(patchRes.status).toBe(401)

    const deleteRes = await request(app).delete(
      `/api/v1/recurring-withdrawals/${planId}`
    )
    expect(deleteRes.status).toBe(401)
  })
})
