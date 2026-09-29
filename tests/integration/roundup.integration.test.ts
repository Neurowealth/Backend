import request from 'supertest'
import express from 'express'

const mockUserId = '11111111-1111-4111-8111-111111111111'
let activeScopes: string[] = ['*']

jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: jest.fn((req: any, _res: any, next: any) => {
    req.userId = mockUserId
    req.auth = {
      userId: mockUserId,
      walletAddress: 'GWALLET_USER_1',
      network: 'TESTNET',
    }
    req.authScopes = activeScopes
    next()
  }),
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
}))

jest.mock('../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

let currentSettings: any = null
let accrualsStore: any[] = []

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    roundUpSettings: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (currentSettings && currentSettings.userId === where.userId) {
          return currentSettings
        }
        return null
      }),
      upsert: jest.fn(async ({ create, update, where }: any) => {
        if (!currentSettings) {
          currentSettings = {
            id: 'settings-mock-id',
            userId: where.userId,
            enabled: create.enabled,
            roundToNearest: create.roundToNearest,
            multiplier: create.multiplier,
            targetGoalId: create.targetGoalId ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        } else {
          currentSettings = {
            ...currentSettings,
            ...update,
            updatedAt: new Date(),
          }
        }
        return currentSettings
      }),
    },
    savingsGoal: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'f47ac10b-58cc-4372-a567-0e02b2c3d479') {
          return { id: where.id, userId: mockUserId, status: 'ACTIVE' }
        }
        return null
      }),
    },
    roundUpAccrual: {
      findMany: jest.fn(async ({ where }: any) => {
        return accrualsStore.filter((a) => a.userId === where.userId)
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0
        for (const a of accrualsStore) {
          if (where.id?.in?.includes(a.id)) {
            Object.assign(a, data)
            count++
          }
        }
        return { count }
      }),
    },
    custodialWallet: {
      findUnique: jest.fn(async () => ({
        userId: mockUserId,
        publicKey: 'GWALLET_USER_1',
      })),
    },
  },
}))

jest.mock('../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn().mockResolvedValue({
    status: 'CONFIRMED',
    transaction: { id: 'mock-tx-1' },
  }),
}))

import roundUpRouter from '../../src/routes/roundup'

const app = express()
app.use(express.json())
app.use('/api/v1/round-up', roundUpRouter)

describe('Round-Up HTTP Integration Tests', () => {
  beforeEach(() => {
    activeScopes = ['*']
    currentSettings = null
    accrualsStore = []
  })

  it('GET /api/v1/round-up/settings returns default settings', async () => {
    const res = await request(app).get('/api/v1/round-up/settings')
    expect(res.status).toBe(200)
    expect(res.body.settings.enabled).toBe(false)
    expect(res.body.settings.multiplier).toBe(1.0)
    expect(res.body.settings.roundToNearest).toBe(1.0)
  })

  it('PATCH /api/v1/round-up/settings updates configuration successfully', async () => {
    const res = await request(app)
      .patch('/api/v1/round-up/settings')
      .send({
        enabled: true,
        multiplier: 2.5,
        roundToNearest: 5.0,
      })

    expect(res.status).toBe(200)
    expect(res.body.settings.enabled).toBe(true)
    expect(res.body.settings.multiplier).toBe(2.5)
    expect(res.body.settings.roundToNearest).toBe(5.0)
  })

  it('PATCH /api/v1/round-up/settings links to an active savings goal', async () => {
    const res = await request(app)
      .patch('/api/v1/round-up/settings')
      .send({
        targetGoalId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      })

    expect(res.status).toBe(200)
    expect(res.body.settings.targetGoalId).toBe(
      'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    )
  })

  it('PATCH /api/v1/round-up/settings returns 404 when target savings goal does not exist', async () => {
    const res = await request(app)
      .patch('/api/v1/round-up/settings')
      .send({
        targetGoalId: '00000000-0000-0000-0000-000000000000',
      })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe(
      'Target savings goal not found or does not belong to user'
    )
  })

  it('PATCH /api/v1/round-up/settings rejects invalid parameters with 400', async () => {
    const res = await request(app)
      .patch('/api/v1/round-up/settings')
      .send({
        multiplier: 50.0,
      })

    expect(res.status).toBe(400)
  })

  it('GET /api/v1/round-up/accrual returns current balance and accrual history', async () => {
    accrualsStore.push({
      id: 'acc-1',
      userId: mockUserId,
      fiatOrderId: 'order-1',
      purchaseAmount: 14.2,
      roundUpAmount: 0.8,
      multiplier: 1.0,
      totalRoundUp: 0.8,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await request(app).get('/api/v1/round-up/accrual')
    expect(res.status).toBe(200)
    expect(res.body.unsweptBalance).toBe(0.8)
    expect(res.body.unsweptCount).toBe(1)
    expect(res.body.currency).toBe('USD')
    expect(res.body.accruals.length).toBe(1)
  })

  it('POST /api/v1/round-up/sweep executes on-demand sweep', async () => {
    accrualsStore.push({
      id: 'acc-2',
      userId: mockUserId,
      fiatOrderId: 'order-2',
      purchaseAmount: 9.1,
      roundUpAmount: 0.9,
      multiplier: 1.0,
      totalRoundUp: 0.9,
      status: 'ACCRUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await request(app)
      .post('/api/v1/round-up/sweep')
      .send({ force: true })

    expect(res.status).toBe(200)
    expect(res.body.sweep.status).toBe('SWEPT')
    expect(res.body.sweep.totalSwept).toBe(0.9)
    expect(res.body.sweep.accrualCount).toBe(1)
  })

  it('enforces API key scope restrictions', async () => {
    activeScopes = ['transactions:read']
    const res = await request(app)
      .patch('/api/v1/round-up/settings')
      .send({ enabled: true })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('insufficient_scope')
  })
})
