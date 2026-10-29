/**
 * Integration tests for Fiat Transaction Limits, Velocity Controls & KYC-Tier Enforcement (#362).
 *
 * Covers:
 *  - GET  /api/v1/fiat/limits
 *  - POST /api/v1/fiat/orders (403 fiat_limit_exceeded on denial, soft warning + fiat.limit.approaching on >80%, compliance_freeze check)
 *  - POST /api/v1/kyc/verify & POST /api/v1/kyc/webhook/:provider
 *  - GET/PUT /api/v1/admin/fiat/limit-policies & POST /api/v1/admin/users/:id/kyc-tier
 */
process.env.NODE_ENV = 'test'
process.env.STELLAR_NETWORK = 'testnet'
process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org'
process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)
process.env.VAULT_CONTRACT_ID = 'C' + 'A'.repeat(55)
process.env.USDC_TOKEN_ADDRESS = 'C' + 'B'.repeat(55)
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
process.env.DATABASE_URL = 'postgresql://localhost:5432/test'
process.env.JWT_SEED = '0'.repeat(64)
process.env.WALLET_ENCRYPTION_KEY = '0'.repeat(64)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)
process.env.KYC_WEBHOOK_SECRET = 'kyc-test-webhook-secret'

import { createHmac } from 'crypto'
import request from 'supertest'
import express from 'express'

const mockUserId = '11111111-1111-4111-8111-111111111111'

jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = mockUserId
    req.auth = { userId: mockUserId, walletAddress: 'GWALLET_USER_1' }
    next()
  },
  enforceUserAccess: (req: any, res: any, next: any) => {
    const target = req.params.userId ?? req.body?.userId
    if (target && target !== req.auth.userId) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  },
}))

jest.mock('../../src/middleware/idempotency', () => ({
  idempotent: () => (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/middleware/adminAuth', () => ({
  requireAdminAuth: (_req: any, res: any, next: any) => {
    res.locals.adminAuth = {
      id: 'admin-key-1',
      name: 'ComplianceAdmin',
      role: 'super',
      scopes: ['super', 'fiat:read', 'fiat:write'],
    }
    next()
  },
  requireAdminScope: () => (_req: any, _res: any, next: any) => next(),
  getAdminAuth: (res: any) => res.locals.adminAuth,
  hasAdminScope: () => true,
  validateScopesInput: () => true,
}))

const mockPublishUserEvent = jest.fn().mockResolvedValue(undefined)
jest.mock('../../src/events/publisher', () => ({
  publishUserEvent: (...args: unknown[]) => mockPublishUserEvent(...args),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const kycProfiles = new Map<string, any>()
const limitPolicies = new Map<string, any>()
const fiatOrders: any[] = []
const complianceCases: any[] = []
const adminAuditLogs: any[] = []

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        isActive: true,
      })),
    },
    complianceCase: {
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          complianceCases.find(
            (c) =>
              c.userId === where.userId && where.status.in.includes(c.status)
          ) ?? null
        )
      }),
    },
    kycProfile: {
      findUnique: jest.fn(
        async ({ where }: any) => kycProfiles.get(where.userId) ?? null
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = kycProfiles.get(where.userId)
        const next = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { ...create, updatedAt: new Date() }
        kycProfiles.set(where.userId, next)
        return next
      }),
    },
    fiatLimitPolicy: {
      findUnique: jest.fn(
        async ({ where }: any) => limitPolicies.get(where.tier) ?? null
      ),
      findMany: jest.fn(async () => Array.from(limitPolicies.values())),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = limitPolicies.get(where.tier)
        const next = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { ...create, updatedAt: new Date() }
        limitPolicies.set(where.tier, next)
        return next
      }),
    },
    fiatOrder: {
      findMany: jest.fn(async ({ where }: any) =>
        fiatOrders.filter((o) => o.userId === where.userId)
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          fiatOrders.find((o) => o.id === where.id) ?? null
      ),
      create: jest.fn(async ({ data }: any) => {
        const created = {
          id: `order-${fiatOrders.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }
        fiatOrders.push(created)
        return created
      }),
    },
    adminAuditLog: {
      create: jest.fn(async ({ data }: any) => {
        adminAuditLogs.push(data)
        return { id: `audit-${adminAuditLogs.length}`, ...data }
      }),
    },
  },
}))

jest.mock('../../src/fiat/registry', () => ({
  getDefaultProvider: () => ({
    name: 'moonpay',
    getQuote: jest.fn().mockResolvedValue({
      provider: 'moonpay',
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      cryptoAmount: 98.5,
      rate: 0.985,
      fees: { providerFee: 1.5, networkFee: 0, fxSpread: 0 },
      unpriced: false,
    }),
    createOrder: jest.fn().mockResolvedValue({
      providerOrderId: `mp_${Date.now()}`,
      checkoutUrl: 'https://buy.moonpay.com/tx',
      status: 'PENDING',
      cryptoAmount: 98.5,
    }),
    verifyWebhookSignature: () => false,
  }),
  getProvider: (name: string) => ({
    name,
    getQuote: jest.fn().mockResolvedValue({
      provider: name,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      cryptoAmount: 98.5,
      rate: 0.985,
      fees: { providerFee: 1.5, networkFee: 0, fxSpread: 0 },
      unpriced: false,
    }),
    createOrder: jest.fn().mockResolvedValue({
      providerOrderId: `mp_${Date.now()}_${Math.random()}`,
      checkoutUrl: 'https://buy.moonpay.com/tx',
      status: 'PENDING',
      cryptoAmount: 98.5,
    }),
    verifyWebhookSignature: () => false,
  }),
  selectProviderForOrder: () => ({
    name: 'moonpay',
    getQuote: jest.fn().mockResolvedValue({
      provider: 'moonpay',
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      cryptoAmount: 98.5,
      rate: 0.985,
      fees: { providerFee: 1.5, networkFee: 0, fxSpread: 0 },
      unpriced: false,
    }),
  }),
  recordProviderSuccess: jest.fn(),
  recordProviderFailure: jest.fn(),
  getAllProviderHealth: () => [],
  adminSetProviderCircuit: jest.fn(),
}))

import fiatRouter from '../../src/routes/fiat'
import kycRouter from '../../src/routes/kyc'
import adminRouter from '../../src/routes/admin'

function buildApp() {
  const app = express()
  // Keep raw body for webhook routes
  app.use('/api/v1/kyc/webhook', express.raw({ type: '*/*', limit: '1mb' }))
  app.use(express.json())
  app.use('/api/v1/fiat', fiatRouter)
  app.use('/api/v1/kyc', kycRouter)
  app.use('/api/v1/admin', adminRouter)
  return app
}

const app = buildApp()

beforeEach(() => {
  kycProfiles.clear()
  limitPolicies.clear()
  fiatOrders.length = 0
  complianceCases.length = 0
  adminAuditLogs.length = 0
  jest.clearAllMocks()
})

describe('Fiat Limits, Velocity & KYC-Tier Enforcement Integration (#362)', () => {
  it('denies unverified (TIER_0) users on POST /api/v1/fiat/orders with 403 fiat_limit_exceeded (tier_zero)', async () => {
    const res = await request(app).post('/api/v1/fiat/orders').send({
      userId: mockUserId,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })

    expect(res.status).toBe(403)
    expect(res.body.details.code).toBe('fiat_limit_exceeded')
    expect(res.body.details.reason).toBe('tier_zero')
    expect(res.body.details.tier).toBe('TIER_0')
  })

  it('initiates KYC verification via POST /api/v1/kyc/verify and updates tier only via signed webhook', async () => {
    // Client cannot pass `tier` to /kyc/verify
    const badRes = await request(app)
      .post('/api/v1/kyc/verify')
      .send({ provider: 'moonpay', tier: 'TIER_3' })
    expect(badRes.status).toBe(400)

    const verifyRes = await request(app)
      .post('/api/v1/kyc/verify')
      .send({ provider: 'moonpay' })
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.body.status).toBe('PENDING')
    expect(verifyRes.body.currentTier).toBe('TIER_0')

    // Unsigned / bad signature webhook is rejected with 401
    const payload = JSON.stringify({
      userId: mockUserId,
      tier: 'TIER_1',
      providerRef: 'prov_ref_abc123',
    })
    const unauthWebhook = await request(app)
      .post('/api/v1/kyc/webhook/moonpay')
      .set('Content-Type', 'application/json')
      .set('x-kyc-signature', 'invalid-sig')
      .send(payload)
    expect(unauthWebhook.status).toBe(401)

    // Valid HMAC-signed provider callback updates KycProfile.tier to TIER_1
    const validSig = createHmac('sha256', process.env.KYC_WEBHOOK_SECRET!)
      .update(payload)
      .digest('hex')
    const validWebhook = await request(app)
      .post('/api/v1/kyc/webhook/moonpay')
      .set('Content-Type', 'application/json')
      .set('x-kyc-signature', validSig)
      .send(payload)
    expect(validWebhook.status).toBe(200)
    expect(validWebhook.body.tier).toBe('TIER_1')

    // GET /api/v1/fiat/limits now reflects TIER_1
    const limitsRes = await request(app).get('/api/v1/fiat/limits')
    expect(limitsRes.status).toBe(200)
    expect(limitsRes.body.tier).toBe('TIER_1')
    expect(limitsRes.body.windows.perTxn.limit).toBe(1000)
    expect(limitsRes.body.windows.daily.limit).toBe(2500)
  })

  it('attaches limitWarning and emits fiat.limit.approaching when order exceeds 80% of a window limit', async () => {
    kycProfiles.set(mockUserId, {
      userId: mockUserId,
      tier: 'TIER_1',
      providerRef: 'ref-1',
    })

    // $900 is 90% of TIER_1 perTxnMax ($1,000) -> > 80% soft warning threshold
    const res = await request(app).post('/api/v1/fiat/orders').send({
      userId: mockUserId,
      direction: 'ON_RAMP',
      fiatAmount: 900,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })

    expect(res.status).toBe(201)
    expect(res.body.limitWarning).toBeDefined()
    expect(res.body.limitWarning.utilizationPct).toBe(90)
    expect(mockPublishUserEvent).toHaveBeenCalledWith(
      mockUserId,
      'alerts',
      'fiat.limit.approaching',
      expect.objectContaining({
        tier: 'TIER_1',
        window: 'per_txn',
        utilizationPct: 90,
      })
    )
  })

  it('denies frozen user (#321 active ComplianceCase) with compliance_freeze even at TIER_3', async () => {
    kycProfiles.set(mockUserId, {
      userId: mockUserId,
      tier: 'TIER_3',
      providerRef: 'ref-3',
    })
    complianceCases.push({
      id: 'case-1',
      userId: mockUserId,
      status: 'INVESTIGATING',
    })

    const res = await request(app).post('/api/v1/fiat/orders').send({
      userId: mockUserId,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })

    expect(res.status).toBe(403)
    expect(res.body.details.code).toBe('fiat_limit_exceeded')
    expect(res.body.details.reason).toBe('compliance_freeze')
  })

  it('supports admin limit-policy tuning and audited manual KYC tier overrides', async () => {
    // Manual KYC override without reviewNote is rejected with 400
    const missingNote = await request(app)
      .post(`/api/v1/admin/users/${mockUserId}/kyc-tier`)
      .send({ tier: 'TIER_2' })
    expect(missingNote.status).toBe(400)

    // Manual KYC override with reviewNote succeeds and logs to adminAuditLog
    const overrideRes = await request(app)
      .post(`/api/v1/admin/users/${mockUserId}/kyc-tier`)
      .send({
        tier: 'TIER_2',
        reviewNote: 'Enhanced verification reviewed manually by compliance',
      })
    expect(overrideRes.status).toBe(200)
    expect(overrideRes.body.data.tier).toBe('TIER_2')
    expect(
      adminAuditLogs.some((a) => a.action === 'OVERRIDE_USER_KYC_TIER')
    ).toBe(true)

    // Admin updates TIER_2 policy via PUT /api/v1/admin/fiat/limit-policies
    const putPolicy = await request(app)
      .put('/api/v1/admin/fiat/limit-policies')
      .send({
        tier: 'TIER_2',
        perTxnMax: 15000,
        dailyMax: 30000,
        monthlyMax: 120000,
        maxTxnsPerHour: 6,
        maxTxnsPerDay: 25,
        currency: 'USD',
      })
    expect(putPolicy.status).toBe(200)
    expect(putPolicy.body.data.policies[0].perTxnMax).toBe(15000)
    expect(
      adminAuditLogs.some((a) => a.action === 'UPDATE_FIAT_LIMIT_POLICIES')
    ).toBe(true)

    const getPolicies = await request(app).get(
      '/api/v1/admin/fiat/limit-policies'
    )
    expect(getPolicies.status).toBe(200)
    const tier2 = getPolicies.body.data.policies.find(
      (p: any) => p.tier === 'TIER_2'
    )
    expect(tier2.perTxnMax).toBe(15000)
  })
})
