// Recurring deposits integration test. Mounts the recurring deposit router on
// a minimal Express app with auth and DB mocked, so it verifies the HTTP wiring
// (validation, status codes, owner-scoping) without a live database.

const mockUserId = '11111111-1111-4111-8111-111111111111'
const mockOtherUserId = '22222222-2222-4222-8222-222222222222'

import request from 'supertest'
import express from 'express'

// --- Auth: stub requireAuth/enforceUserAccess to inject a fixed identity ------
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

// --- DB: in-memory store for recurring deposit plans --------------------------
const plans = new Map<string, any>()
let planSeq = 0

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    recurringDepositPlan: {
      create: jest.fn(async ({ data }: any) => {
        const id = `plan-${++planSeq}`
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
      update: jest.fn(async ({ where, data }: any) => {
        const plan = plans.get(where.id)
        if (!plan) throw new Error('Plan not found')
        Object.assign(plan, data)
        plan.updatedAt = new Date()
        return plan
      }),
    },
  },
}))

import db from '../../src/db'
import recurringDepositRouter from '../../src/routes/recurring-deposits'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/deposit/recurring', recurringDepositRouter)
  return app
}

describe('E2E integration — recurring deposits', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    plans.clear()
    planSeq = 0
  })

  it('POST → creates plan, GET lists it, DELETE cancels it', async () => {
    const app = buildApp()

    // Create
    const createRes = await request(app)
      .post('/api/v1/deposit/recurring')
      .send({
        userId: mockUserId,
        amount: 50,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
      })

    expect(createRes.status).toBe(201)
    expect(createRes.body.plan).toBeDefined()
    expect(createRes.body.plan.userId).toBe(mockUserId)
    expect(createRes.body.plan.amount).toBe(50)
    expect(createRes.body.plan.cadence).toBe('WEEKLY')
    expect(createRes.body.plan.status).toBe('ACTIVE')
    expect(createRes.body.plan.nextRunAt).toBeDefined()

    const planId = createRes.body.plan.id

    // List
    const listRes = await request(app).get(
      `/api/v1/deposit/recurring/by-user/${mockUserId}`
    )

    expect(listRes.status).toBe(200)
    expect(listRes.body.plans).toHaveLength(1)
    expect(listRes.body.plans[0].id).toBe(planId)

    // Cancel
    const deleteRes = await request(app).delete(
      `/api/v1/deposit/recurring/${planId}`
    )

    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.plan.status).toBe('CANCELLED')
  })

  it('PATCH — pauses and resumes a plan', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/deposit/recurring')
      .send({
        userId: mockUserId,
        amount: 100,
        assetSymbol: 'USDC',
        cadence: 'MONTHLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    // Pause
    const pauseRes = await request(app)
      .patch(`/api/v1/deposit/recurring/${planId}`)
      .send({ status: 'PAUSED' })

    expect(pauseRes.status).toBe(200)
    expect(pauseRes.body.plan.status).toBe('PAUSED')

    // Resume
    const resumeRes = await request(app)
      .patch(`/api/v1/deposit/recurring/${planId}`)
      .send({ status: 'ACTIVE' })

    expect(resumeRes.status).toBe(200)
    expect(resumeRes.body.plan.status).toBe('ACTIVE')
  })

  it('ownership check: user B cannot modify user A plan', async () => {
    const app = buildApp()

    const createRes = await request(app)
      .post('/api/v1/deposit/recurring')
      .send({
        userId: mockUserId,
        amount: 50,
        assetSymbol: 'USDC',
        cadence: 'WEEKLY',
        confirmed: true,
      })

    const planId = createRes.body.plan.id

    // Switch identity to user B for subsequent requests
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

    // User B tries to pause user A's plan
    const patchRes = await request(app)
      .patch(`/api/v1/deposit/recurring/${planId}`)
      .send({ status: 'PAUSED' })

    expect(patchRes.status).toBe(401)

    // User B tries to cancel user A's plan
    const deleteRes = await request(app).delete(
      `/api/v1/deposit/recurring/${planId}`
    )

    expect(deleteRes.status).toBe(401)
  })

  it('creation rejects when confirmed is not true', async () => {
    const app = buildApp()

    const res = await request(app).post('/api/v1/deposit/recurring').send({
      userId: mockUserId,
      amount: 50,
      assetSymbol: 'USDC',
      cadence: 'WEEKLY',
      confirmed: false,
    })

    expect(res.status).toBe(400)
  })
})
