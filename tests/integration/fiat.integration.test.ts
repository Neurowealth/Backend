// #290 — Fiat routes integration test. Mounts the fiat router on a minimal
// Express app with the auth middleware and service layer mocked, so it verifies
// the HTTP wiring (validation, status codes, owner-scoping, and the raw-body
// webhook signature path) without a live database or provider network calls.
const mockUserId = '11111111-1111-4111-8111-111111111111'
const mockOtherUserId = '22222222-2222-4222-8222-222222222222'

import request from 'supertest'
import express from 'express'

// --- Auth: stub requireAuth/enforceUserAccess to inject a fixed identity ------
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

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../src/middleware/idempotency', () => ({
  idempotent: () => (_req: any, _res: any, next: any) => next(),
}))

// --- Service layer: mock so no DB / provider network is touched ---------------
const mockGetFiatQuote = jest.fn()
const mockGetBestExecutionQuote = jest.fn()
const mockCreateFiatOrder = jest.fn()
const mockProcessProviderWebhook = jest.fn()
jest.mock('../../src/fiat/service', () => ({
  getFiatQuote: (...a: unknown[]) => mockGetFiatQuote(...a),
  getBestExecutionQuote: (...a: unknown[]) => mockGetBestExecutionQuote(...a),
  createFiatOrder: (...a: unknown[]) => mockCreateFiatOrder(...a),
  processProviderWebhook: (...a: unknown[]) => mockProcessProviderWebhook(...a),
}))

// --- Provider registry: a stub provider with controllable verification --------
const mockVerify = jest.fn()
const mockParse = jest.fn()
jest.mock('../../src/fiat/registry', () => ({
  getProvider: (name: string) => {
    if (name !== 'moonpay') throw new Error(`Unknown fiat provider: "${name}"`)
    return {
      name: 'moonpay',
      verifyWebhookSignature: (...a: unknown[]) => mockVerify(...a),
      parseWebhookPayload: (...a: unknown[]) => mockParse(...a),
    }
  },
}))

// --- DB: history/detail routes read fiatOrder directly ------------------------
jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    fiatOrder: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}))
import db from '../../src/db'
import fiatRouter from '../../src/routes/fiat'

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/fiat', fiatRouter)
  return app
}

const app = buildApp()

beforeEach(() => {
  jest.clearAllMocks()
})

describe('POST /api/fiat/quote', () => {
  it('returns a quote for a valid request', async () => {
    mockGetFiatQuote.mockResolvedValue({
      provider: 'moonpay',
      cryptoAmount: 98.5,
    })
    const res = await request(app).post('/api/fiat/quote').send({
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'usd',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(200)
    expect(res.body.cryptoAmount).toBe(98.5)
  })

  it('rejects an invalid body with 400', async () => {
    const res = await request(app).post('/api/fiat/quote').send({
      direction: 'SIDEWAYS',
      fiatAmount: -5,
      fiatCurrency: 'usd',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(400)
    expect(mockGetFiatQuote).not.toHaveBeenCalled()
  })

  it('returns 502 when the provider errors', async () => {
    mockGetFiatQuote.mockRejectedValue(new Error('provider down'))
    const res = await request(app).post('/api/fiat/quote').send({
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(502)
  })
})

describe('GET /api/fiat/quotes', () => {
  it('returns the ranked best-execution result for a valid request', async () => {
    mockGetBestExecutionQuote.mockResolvedValue({
      best: {
        provider: 'sandbox',
        cryptoAmount: 99,
        quoteId: 'lock-1',
        rank: 1,
      },
      quotes: [
        { provider: 'sandbox', cryptoAmount: 99, quoteId: 'lock-1', rank: 1 },
        { provider: 'moonpay', cryptoAmount: 98, quoteId: 'lock-2', rank: 2 },
      ],
      excluded: [],
    })
    const res = await request(app).get('/api/fiat/quotes').query({
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(200)
    expect(res.body.best.provider).toBe('sandbox')
    expect(res.body.quotes).toHaveLength(2)
    expect(mockGetBestExecutionQuote).toHaveBeenCalledWith(
      expect.objectContaining({ fiatAmount: 100 }),
      { userId: mockUserId }
    )
  })

  it('rejects an invalid query with 400', async () => {
    const res = await request(app).get('/api/fiat/quotes').query({
      direction: 'SIDEWAYS',
      fiatAmount: -5,
      fiatCurrency: 'usd',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(400)
    expect(mockGetBestExecutionQuote).not.toHaveBeenCalled()
  })

  it('returns 503 with a structured error when no provider is healthy', async () => {
    const { NoHealthyProvidersError } = jest.requireActual(
      '../../src/fiat/types'
    )
    mockGetBestExecutionQuote.mockRejectedValue(
      new NoHealthyProvidersError([
        { provider: 'moonpay', reason: 'circuit open' },
        { provider: 'sandbox', reason: 'circuit open' },
      ])
    )
    const res = await request(app).get('/api/fiat/quotes').query({
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(503)
    expect(res.body.details.code).toBe('no_healthy_providers')
    expect(res.body.details.failures).toHaveLength(2)
  })
})

describe('POST /api/fiat/orders', () => {
  it('creates an order for the authenticated user', async () => {
    mockCreateFiatOrder.mockResolvedValue({
      id: 'order-1',
      status: 'PENDING',
      checkoutUrl: 'https://pay',
    })
    const res = await request(app).post('/api/fiat/orders').send({
      userId: mockUserId,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(201)
    expect(res.body.checkoutUrl).toBe('https://pay')
    // The wallet address comes from the authenticated session, not the body.
    expect(mockCreateFiatOrder).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ walletAddress: 'GWALLET_USER_1' })
    )
  })

  it('forbids creating an order on behalf of another user', async () => {
    const res = await request(app).post('/api/fiat/orders').send({
      userId: mockOtherUserId,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(403)
    expect(mockCreateFiatOrder).not.toHaveBeenCalled()
  })

  it('rejects an expired locked quote with 409 quote_expired (#313)', async () => {
    const { FiatOrderError } = jest.requireActual('../../src/fiat/types')
    mockCreateFiatOrder.mockRejectedValue(
      new FiatOrderError(
        'quote_expired',
        409,
        'Quote is no longer valid — request a fresh quote',
        { freshQuoteUrl: '/api/v1/fiat/quotes' }
      )
    )
    const res = await request(app).post('/api/fiat/orders').send({
      userId: mockUserId,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      quoteId: '11111111-1111-4111-8111-111111111112',
    })
    expect(res.status).toBe(409)
    expect(res.body.details.code).toBe('quote_expired')
    expect(res.body.details.freshQuoteUrl).toBe('/api/v1/fiat/quotes')
  })

  it('returns 503 with a structured error when no provider is healthy', async () => {
    const { NoHealthyProvidersError } = jest.requireActual(
      '../../src/fiat/types'
    )
    mockCreateFiatOrder.mockRejectedValue(
      new NoHealthyProvidersError([
        { provider: 'moonpay', reason: 'circuit open' },
      ])
    )
    const res = await request(app).post('/api/fiat/orders').send({
      userId: mockUserId,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    expect(res.status).toBe(503)
    expect(res.body.details.code).toBe('no_healthy_providers')
  })

  it('forwards an explicit provider preference to the service layer', async () => {
    mockCreateFiatOrder.mockResolvedValue({ id: 'order-2', status: 'PENDING' })
    await request(app).post('/api/fiat/orders').send({
      userId: mockUserId,
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      provider: 'sandbox',
    })
    expect(mockCreateFiatOrder).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'sandbox' }),
      expect.objectContaining({ walletAddress: 'GWALLET_USER_1' })
    )
  })
})

describe('GET /api/fiat/orders', () => {
  it('lists only the caller-scoped orders', async () => {
    mockDb.fiatOrder.findMany.mockResolvedValue([{ id: 'order-1' }])
    const res = await request(app).get('/api/fiat/orders')
    expect(res.status).toBe(200)
    expect(res.body.orders).toHaveLength(1)
    expect(mockDb.fiatOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: mockUserId } })
    )
  })
})

describe('GET /api/fiat/orders/:id', () => {
  it('returns the order when owned by the caller', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      userId: mockUserId,
    })
    const res = await request(app).get('/api/fiat/orders/order-1')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('order-1')
  })

  it("returns 404 for another user's order (no existence leak)", async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      userId: 'other',
    })
    const res = await request(app).get('/api/fiat/orders/order-1')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/fiat/webhook/:provider', () => {
  it('returns 404 for an unknown provider', async () => {
    const res = await request(app).post('/api/fiat/webhook/unknown').send({})
    expect(res.status).toBe(404)
  })

  it('rejects a delivery whose signature fails verification with 401', async () => {
    mockVerify.mockReturnValue(false)
    const res = await request(app)
      .post('/api/fiat/webhook/moonpay')
      .set('Content-Type', 'application/json')
      .send({ data: { id: 'mp_1' } })
    expect(res.status).toBe(401)
    expect(mockProcessProviderWebhook).not.toHaveBeenCalled()
  })

  it('processes a verified delivery and ACKs 200', async () => {
    mockVerify.mockReturnValue(true)
    mockParse.mockReturnValue({ providerOrderId: 'mp_1', status: 'PROCESSING' })
    mockProcessProviderWebhook.mockResolvedValue({
      handled: true,
      orderId: 'order-1',
      status: 'PROCESSING',
    })
    const res = await request(app)
      .post('/api/fiat/webhook/moonpay')
      .set('Content-Type', 'application/json')
      .send({ data: { id: 'mp_1', status: 'pending' } })
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(true)
    expect(mockProcessProviderWebhook).toHaveBeenCalledWith('moonpay', {
      providerOrderId: 'mp_1',
      status: 'PROCESSING',
    })
  })

  it('returns 400 on a malformed (unparseable) payload', async () => {
    mockVerify.mockReturnValue(true)
    mockParse.mockImplementation(() => {
      throw new Error('bad json')
    })
    const res = await request(app)
      .post('/api/fiat/webhook/moonpay')
      .set('Content-Type', 'application/json')
      .send({ data: {} })
    expect(res.status).toBe(400)
  })

  it('returns 500 when processing throws (provider should retry)', async () => {
    mockVerify.mockReturnValue(true)
    mockParse.mockReturnValue({ providerOrderId: 'mp_1', status: 'PROCESSING' })
    mockProcessProviderWebhook.mockRejectedValue(new Error('db down'))
    const res = await request(app)
      .post('/api/fiat/webhook/moonpay')
      .set('Content-Type', 'application/json')
      .send({ data: { id: 'mp_1' } })
    expect(res.status).toBe(500)
  })
})
