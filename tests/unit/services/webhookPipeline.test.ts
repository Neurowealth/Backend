/**
 * #496 — End-to-end coverage of the operator webhook notification pipeline.
 *
 * deliverToSubscription is the leg that turns an emitted domain event into a
 * signed HTTP delivery. The acceptance criteria in #496 (success and failure
 * paths, retry events, incident context on failure) map to:
 *
 *   success      → delivery row goes PENDING -> SUCCESS, no dead letter
 *   exhausted    → every attempt fails: FAILED row + webhookDeadLetter row
 *                  carrying the last error (incident context)
 *   breaker open → delivery is skipped and dead-lettered without any HTTP
 *                  call
 *   fan-out      → dispatchWebhookEvent reaches every active subscription
 *                  listening for the event
 *
 * Global fetch is mocked, and the Prisma-facing `db` default export is
 * replaced with an in-memory stand-in for the three tables the pipeline
 * touches (webhookSubscription / webhookDelivery / webhookDeadLetter).
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

// Keep the retry loop instant: zero base delay makes full-jitter backoff 0ms.
process.env.WEBHOOK_BASE_DELAY_MS = '0'

import db from '../../../src/db'
import {
  deliverToSubscription,
  dispatchWebhookEvent,
} from '../../../src/services/webhookDispatcher'
import {
  recordDeliveryFailure,
  resetSubscriptionHealth,
  _clearAllHealth,
} from '../../../src/services/webhookCircuitBreaker'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockDb = db as any

let fetchCalls: { url: string; init: any }[] = []
let fetchResponder: (url: string, init: any) => { ok: boolean; status: number }

const subscriptions = { findManyResult: [] as any[] }

const baseSub = {
  id: 'sub-1',
  url: 'https://ops.example.com/hook',
  secret: 'whsec_test_secret',
  secretNext: null,
  userId: 'user-1',
}

function lastDeadLetter(): any {
  const calls = mockDb.webhookDeadLetter.create.mock.calls
  return calls[calls.length - 1][0].data
}

beforeEach(() => {
  jest.clearAllMocks()
  // The circuit breaker keeps module-level state; tests open it deliberately,
  // so every test starts from a clean slate.
  _clearAllHealth()

  let deliverySeq = 0
  mockDb.webhookSubscription = {
    findMany: jest.fn(async () => subscriptions.findManyResult),
    update: jest.fn(async ({ where }: any) => ({ id: where.id })),
  }
  mockDb.webhookDelivery = {
    create: jest.fn(async ({ data }: any) => ({
      id: `delivery-${++deliverySeq}`,
      ...data,
    })),
    update: jest.fn(async ({ data }: any) => ({ id: 'delivery-x', ...data })),
  }
  mockDb.webhookDeadLetter = {
    create: jest.fn(async ({ data }: any) => ({ id: 'dl-1', ...data })),
    findUnique: jest.fn(),
    update: jest.fn(),
  }

  subscriptions.findManyResult = [{ ...baseSub }]
  fetchCalls = []
  fetchResponder = () => ({ ok: true, status: 200 })
  global.fetch = jest.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init })
    return fetchResponder(String(url), init)
  }) as any
})

describe('webhook notification pipeline (#496)', () => {
  it('delivers a signed request and marks the delivery SUCCESS on 2xx', async () => {
    await deliverToSubscription(baseSub, 'deposit.received', {
      txHash: 'abc',
      amount: '10',
    })

    // One signed HTTP POST to the subscriber's URL...
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(baseSub.url)
    expect(fetchCalls[0].init.method).toBe('POST')

    // ...carrying the hardened #377 combined signature header
    // (v2 = timestamp.deliveryId.body, v1 = legacy body-only; both hex).
    const signature = fetchCalls[0].init.headers['X-NW-Webhook-Signature']
    const parts = signature.split(' ')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^v2,[a-f0-9]{64}$/)
    expect(parts[1]).toMatch(/^v1,[a-f0-9]{64}$/)
    expect(fetchCalls[0].init.headers['X-NW-Webhook-Id']).toBeDefined()

    // ...and the delivery row lands in the SUCCESS state.
    const createArg = mockDb.webhookDelivery.create.mock.calls[0][0]
    expect(createArg.data.status).toBe('PENDING')
    expect(createArg.data.event).toBe('deposit.received')
    expect(mockDb.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCESS',
          attempts: 1,
          error: null,
        }),
      })
    )
    // Success path must not create incident context.
    expect(mockDb.webhookDeadLetter.create).not.toHaveBeenCalled()
  })

  it('exhausts all retry attempts and dead-letters with the last error', async () => {
    fetchResponder = () => ({ ok: false, status: 500 })

    await deliverToSubscription(baseSub, 'outbox.op_failed', { opId: 'op-1' })

    // WEBHOOK_MAX_ATTEMPTS (default 6) HTTP attempts were made.
    expect(fetchCalls).toHaveLength(6)
    expect(mockDb.webhookDelivery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          attempts: 6,
        }),
      })
    )
    // The dead letter carries the incident context operators triage on.
    expect(mockDb.webhookDeadLetter.create).toHaveBeenCalledTimes(1)
    const dl = lastDeadLetter()
    expect(dl.subscriptionId).toBe(baseSub.id)
    expect(dl.event).toBe('outbox.op_failed')
    expect(dl.lastError).toBe('HTTP 500')
    expect(dl.attempts).toBe(6)
    expect(dl.status).toBe('PENDING')
    expect(dl.payload).toEqual({ opId: 'op-1' })
  })

  it('records a network-level failure (no HTTP status) in the dead letter', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND ops.example.com')
    )

    await deliverToSubscription(baseSub, 'transaction.confirmed', {
      txHash: 'tx-9',
    })

    expect(mockDb.webhookDeadLetter.create).toHaveBeenCalledTimes(1)
    expect(lastDeadLetter().lastError).toContain('ENOTFOUND')
  })

  it('skips HTTP entirely and dead-letters when the circuit breaker is open', async () => {
    // Open the breaker for this subscription through the public surface.
    for (let i = 0; i < 100; i++) {
      recordDeliveryFailure(baseSub.id)
    }

    await deliverToSubscription(baseSub, 'deposit.received', { txHash: 'x' })

    // Breaker open → no network call, dead letter with the skip reason.
    expect(fetchCalls).toHaveLength(0)
    expect(mockDb.webhookDeadLetter.create).toHaveBeenCalledTimes(1)
    const dl = lastDeadLetter()
    expect(dl.lastError).toContain('Circuit breaker open')
    expect(dl.attempts).toBe(0)
    // The delivery row was never created.
    expect(mockDb.webhookDelivery.create).not.toHaveBeenCalled()

    // Health tracking stays scoped to the failing subscription.
    resetSubscriptionHealth(baseSub.id)
  })

  it('fans an event out to every active subscriber listening for it', async () => {
    subscriptions.findManyResult = [
      { ...baseSub },
      { ...baseSub, id: 'sub-2', url: 'https://ops2.example.com/hook' },
    ]

    await dispatchWebhookEvent('deposit.received', { txHash: 'abc' })

    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://ops.example.com/hook',
      'https://ops2.example.com/hook',
    ])
  })

  it('does not deliver when no active subscription listens for the event', async () => {
    subscriptions.findManyResult = []

    await dispatchWebhookEvent('fiat.order.failed', { orderId: 'o-1' })

    expect(fetchCalls).toHaveLength(0)
    expect(mockDb.webhookDelivery.create).not.toHaveBeenCalled()
  })

  it('preserves the payload verbatim for the signed request body', async () => {
    await dispatchWebhookEvent('deposit.received', {
      txHash: 'abc',
      amount: '10',
    })

    const body = JSON.parse(fetchCalls[0].init.body)
    expect(body.event).toBe('deposit.received')
    expect(body.data).toEqual({ txHash: 'abc', amount: '10' })
    // The envelope timestamp is an ISO string generated at dispatch time.
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })
})
