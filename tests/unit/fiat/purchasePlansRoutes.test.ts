import express from 'express'
import request from 'supertest'
import db from '../../../src/db'
import fiatRouter from '../../../src/routes/fiat'
import { getBestExecutionQuote } from '../../../src/fiat/service'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))
jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    const userId =
      req.headers['x-test-user-id'] || '11111111-1111-4111-8111-111111111111'
    req.userId = userId
    req.auth = {
      userId,
      walletAddress: 'GUSERWALLET1234567890',
      authMethod: 'jwt',
    }
    next()
  },
  enforceUserAccess: (_req: any, _res: any, next: any) => next(),
}))
jest.mock('../../../src/middleware/apiKeyAuth', () => ({
  requireScope: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('../../../src/middleware/idempotency', () => ({
  idempotent: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('../../../src/fiat/service', () => ({
  getFiatQuote: jest.fn(),
  getBestExecutionQuote: jest.fn(),
  createFiatOrder: jest.fn(),
  hasProviderWebhookReplay: jest.fn(),
  processProviderWebhook: jest.fn(),
  recordProviderWebhookDelivery: jest.fn(),
}))

const mockDb = db as any
const mockGetQuote = getBestExecutionQuote as jest.Mock

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const CHILD_ID = '22222222-2222-4222-8222-222222222222'
const PLAN_ID = '33333333-3333-4333-8333-333333333333'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/fiat', fiatRouter)
  return app
}

describe('Scheduled Fiat Purchase Plans Routes (#361)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.user = {
      findUnique: jest.fn().mockResolvedValue({
        id: OWNER_ID,
        isActive: true,
        isFrozen: false,
      }),
    }
    mockDb.complianceCase = {
      findFirst: jest.fn().mockResolvedValue(null),
    }
    mockDb.subAccount = {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    }
    mockDb.fiatPurchasePlan = {
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: PLAN_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      })),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => ({
        id: where.id,
        userId: OWNER_ID,
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
        paymentMethodRef: 'pm_tok_visa_4242',
        cadence: 'WEEKLY',
        status: 'ACTIVE',
        autoDeposit: true,
        ...data,
      })),
    }
    mockDb.fiatPurchasePlanRun = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    }
    mockDb.auditPayloadHash = {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }
    mockGetQuote.mockResolvedValue({
      best: {
        provider: 'moonpay',
        quoteId: 'quote-1',
        cryptoAmount: 100,
        rate: 1.0,
      },
      quotes: [],
      excluded: [],
    })
  })

  it('creates a purchase plan (201) and records an audit payload hash', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/fiat/purchase-plans')
      .send({
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
        paymentMethodRef: 'pm_tok_visa_4242',
        cadence: 'WEEKLY',
        autoDeposit: true,
        maxSlippagePct: 0.02,
      })

    expect(res.status).toBe(201)
    expect(res.body.plan.id).toBe(PLAN_ID)
    expect(res.body.plan.baselineRate).toBe(1.0)
    expect(mockDb.auditPayloadHash.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tableName: 'fiat_purchase_plans',
          kind: 'PLAN_CREATED',
        }),
      })
    )
  })

  it('rejects raw card PAN strings in paymentMethodRef with 400', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/fiat/purchase-plans')
      .send({
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
        paymentMethodRef: '4242-4242-4242-4242',
        cadence: 'WEEKLY',
      })

    expect(res.status).toBe(400)
    expect(mockDb.fiatPurchasePlan.create).not.toHaveBeenCalled()
  })

  it('returns 403 when a sub-account lacks DEPOSIT permission', async () => {
    const app = buildApp()
    mockDb.subAccount.findFirst.mockResolvedValue({
      id: 'sub-1',
      parentUserId: OWNER_ID,
      childUserId: CHILD_ID,
      status: 'ACTIVE',
      permissions: ['VIEW'], // Missing DEPOSIT
    })

    const res = await request(app)
      .post('/api/v1/fiat/purchase-plans')
      .set('x-test-user-id', CHILD_ID)
      .send({
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
        paymentMethodRef: 'pm_tok_visa_4242',
        cadence: 'WEEKLY',
      })

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('DEPOSIT')
  })

  it('returns 403 when user has an active compliance freeze', async () => {
    const app = buildApp()
    mockDb.complianceCase.findFirst.mockResolvedValue({
      id: 'case-1',
      status: 'OPEN',
    })

    const res = await request(app)
      .post('/api/v1/fiat/purchase-plans')
      .send({
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
        paymentMethodRef: 'pm_tok_visa_4242',
        cadence: 'WEEKLY',
      })

    expect(res.status).toBe(403)
  })

  it('updates/pauses/resumes and cancels a plan with audit logging, and previews upcoming runs', async () => {
    const app = buildApp()
    mockDb.fiatPurchasePlan.findUnique.mockResolvedValue({
      id: PLAN_ID,
      userId: OWNER_ID,
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      paymentMethodRef: 'pm_tok_visa_4242',
      cadence: 'WEEKLY',
      nextRunAt: new Date('2026-10-20T00:00:00.000Z'),
      status: 'PAUSED',
      autoDeposit: true,
      baselineRate: 1.0,
      maxSlippagePct: 0.02,
    })

    const resumeRes = await request(app)
      .patch(`/api/v1/fiat/purchase-plans/${PLAN_ID}`)
      .send({ status: 'ACTIVE', fiatAmount: 150 })
    expect(resumeRes.status).toBe(200)
    expect(mockDb.auditPayloadHash.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'PLAN_RESUMED' }),
      })
    )

    const previewRes = await request(app).get(
      `/api/v1/fiat/purchase-plans/${PLAN_ID}/preview?runs=3`
    )
    expect(previewRes.status).toBe(200)
    expect(previewRes.body.runs).toHaveLength(3)

    const cancelRes = await request(app).delete(
      `/api/v1/fiat/purchase-plans/${PLAN_ID}`
    )
    expect(cancelRes.status).toBe(200)
    expect(cancelRes.body.plan.status).toBe('CANCELLED')
  })
})
