// #290 — Fiat service unit tests. These pin the safety-critical invariants:
//   * a provider "completed" webhook advances to PROCESSING, never SETTLED
//   * settlement requires an independently CONFIRMED on-chain transaction
//   * webhook processing is idempotent (terminal states are immutable)
//   * a claimed tx hash belonging to another user is never linked
//   * stale PENDING orders are aged out to FAILED
import db from '../../../src/db'
import { dispatchWebhookEvent } from '../../../src/services/webhookDispatcher'
import { alertingService } from '../../../src/services/alerting'
import {
  processProviderWebhook,
  reconcileSingleOrder,
  reconcileFiatOrders,
  ageOutStaleFiatOrders,
  STALE_ORDER_MAX_AGE_MS,
} from '../../../src/fiat/service'
import type { ParsedWebhook } from '../../../src/fiat/types'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock('../../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))

const mockDb = db as any
const mockDispatch = dispatchWebhookEvent as jest.Mock
const mockEmit = alertingService.emit as jest.Mock

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    userId: 'user-1',
    provider: 'moonpay',
    providerOrderId: 'mp_1',
    direction: 'ON_RAMP',
    assetSymbol: 'USDC',
    cryptoAmount: null,
    status: 'PENDING',
    createdAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.fiatOrder = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  }
  mockDb.transaction = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  }
})

describe('processProviderWebhook', () => {
  it('advances a PROCESSING/completed signal to PROCESSING, never SETTLED', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(baseOrder())
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))

    const parsed: ParsedWebhook = { providerOrderId: 'mp_1', status: 'SETTLED' }
    const res = await processProviderWebhook('moonpay', parsed)

    expect(res.handled).toBe(true)
    const updateArg = mockDb.fiatOrder.update.mock.calls[0][0]
    expect(updateArg.data.status).toBe('PROCESSING')
    expect(updateArg.data.status).not.toBe('SETTLED')
  })

  it('is idempotent — a terminal order is not mutated by a later delivery', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(
      baseOrder({ status: 'SETTLED' })
    )

    const res = await processProviderWebhook('moonpay', {
      providerOrderId: 'mp_1',
      status: 'FAILED',
    })

    expect(res.handled).toBe(true)
    expect(res.reason).toBe('already terminal')
    expect(mockDb.fiatOrder.update).not.toHaveBeenCalled()
  })

  it('acknowledges but does not act on an unknown order', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(null)

    const res = await processProviderWebhook('moonpay', {
      providerOrderId: 'nope',
      status: 'FAILED',
    })

    expect(res.handled).toBe(false)
    expect(res.reason).toBe('unknown order')
    expect(mockDb.fiatOrder.update).not.toHaveBeenCalled()
  })

  it('marks FAILED with a reason and emits an outbound webhook', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(baseOrder())
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))

    await processProviderWebhook('moonpay', {
      providerOrderId: 'mp_1',
      status: 'FAILED',
      reason: 'card_declined',
    })

    const updateArg = mockDb.fiatOrder.update.mock.calls[0][0]
    expect(updateArg.data.status).toBe('FAILED')
    expect(updateArg.data.failureReason).toBe('card_declined')
    expect(mockDispatch).toHaveBeenCalledWith(
      'fiat.order.failed',
      expect.objectContaining({ status: 'FAILED' })
    )
  })

  it('rejects a webhook with no providerOrderId', async () => {
    const res = await processProviderWebhook('moonpay', {
      providerOrderId: '',
      status: 'PENDING',
    })
    expect(res.handled).toBe(false)
    expect(mockDb.fiatOrder.findUnique).not.toHaveBeenCalled()
  })

  it('runs inline reconciliation when a tx hash is supplied and the order goes PROCESSING', async () => {
    mockDb.fiatOrder.findUnique
      .mockResolvedValueOnce(baseOrder()) // webhook lookup
      .mockResolvedValueOnce(baseOrder({ status: 'PROCESSING' })) // reconcileSingleOrder lookup
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 98.5,
    })

    await processProviderWebhook('moonpay', {
      providerOrderId: 'mp_1',
      status: 'SETTLED',
      txHash: '0xabc',
    })

    // Second update is the settlement.
    const settleCall = mockDb.fiatOrder.update.mock.calls.find(
      (c: any) => c[0].data.status === 'SETTLED'
    )
    expect(settleCall).toBeDefined()
    expect(settleCall[0].data.transactionId).toBe('tx-1')
  })
})

describe('reconcileSingleOrder', () => {
  it('settles only when a CONFIRMED transaction exists for the same user', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(
      baseOrder({ status: 'PROCESSING' })
    )
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 100,
    })
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))

    const ok = await reconcileSingleOrder('order-1', '0xabc')

    expect(ok).toBe(true)
    expect(mockDb.fiatOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SETTLED',
          transactionId: 'tx-1',
        }),
      })
    )
    expect(mockDispatch).toHaveBeenCalledWith(
      'fiat.order.settled',
      expect.objectContaining({ txHash: '0xabc' })
    )
  })

  it('does not settle when the transaction is not yet CONFIRMED', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(
      baseOrder({ status: 'PROCESSING' })
    )
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'PENDING',
      userId: 'user-1',
      amount: 100,
    })

    const ok = await reconcileSingleOrder('order-1', '0xabc')

    expect(ok).toBe(false)
    expect(mockDb.fiatOrder.update).not.toHaveBeenCalled()
  })

  it('refuses to link a tx hash that belongs to a different user', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(
      baseOrder({ status: 'PROCESSING' })
    )
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'attacker',
      amount: 100,
    })

    const ok = await reconcileSingleOrder('order-1', '0xabc')

    expect(ok).toBe(false)
    expect(mockDb.fiatOrder.update).not.toHaveBeenCalled()
  })

  it('is a no-op for an already-terminal order', async () => {
    mockDb.fiatOrder.findUnique.mockResolvedValue(
      baseOrder({ status: 'SETTLED' })
    )
    const ok = await reconcileSingleOrder('order-1', '0xabc')
    expect(ok).toBe(false)
    expect(mockDb.transaction.findUnique).not.toHaveBeenCalled()
  })
})

describe('reconcileSingleOrder — quoted-vs-settled drift (#313)', () => {
  it('persists settledCryptoAmount/settledRate and emits rate_mismatch when drift exceeds tolerance', async () => {
    const order = baseOrder({
      status: 'PROCESSING',
      fiatAmount: 100,
      quotedCryptoAmount: 100,
      provider: 'moonpay',
    })
    mockDb.fiatOrder.findUnique.mockResolvedValue(order)
    // 10% short of quote — well beyond the 2% default tolerance.
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 90,
    })
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))

    const ok = await reconcileSingleOrder('order-1', '0xabc')

    expect(ok).toBe(true)
    const updateArg = mockDb.fiatOrder.update.mock.calls[0][0]
    expect(updateArg.data.settledCryptoAmount).toBe(90)
    expect(updateArg.data.settledRate).toBeCloseTo(0.9)
    expect(mockDispatch).toHaveBeenCalledWith(
      'fiat.order.rate_mismatch',
      expect.objectContaining({
        orderId: 'order-1',
        quotedCryptoAmount: 100,
        settledCryptoAmount: 90,
      })
    )
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'fiat-settlement' }),
      expect.stringContaining('fiat:drift:')
    )
  })

  it('does not alert when settlement drift is within tolerance', async () => {
    const order = baseOrder({
      status: 'PROCESSING',
      fiatAmount: 100,
      quotedCryptoAmount: 100,
    })
    mockDb.fiatOrder.findUnique.mockResolvedValue(order)
    // 1% short — within the 2% default tolerance.
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 99,
    })
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))

    await reconcileSingleOrder('order-1', '0xabc')

    expect(mockDispatch).not.toHaveBeenCalledWith(
      'fiat.order.rate_mismatch',
      expect.anything()
    )
  })

  it('still alerts on over-delivery (credited, not capped) for audit visibility', async () => {
    const order = baseOrder({
      status: 'PROCESSING',
      fiatAmount: 100,
      cryptoAmount: 100,
      quotedCryptoAmount: 100,
    })
    mockDb.fiatOrder.findUnique.mockResolvedValue(order)
    // 15% more than quoted.
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 115,
    })
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))

    await reconcileSingleOrder('order-1', '0xabc')

    const updateArg = mockDb.fiatOrder.update.mock.calls[0][0]
    // The original quoted cryptoAmount promised to the user is never reduced,
    // but the realized (better) amount is still captured for audit visibility.
    expect(updateArg.data.cryptoAmount).toBe(100)
    expect(updateArg.data.settledCryptoAmount).toBe(115)
    expect(mockDispatch).toHaveBeenCalledWith(
      'fiat.order.rate_mismatch',
      expect.objectContaining({ driftPct: expect.any(Number) })
    )
  })
})

describe('reconcileFiatOrders', () => {
  it('settles PROCESSING orders that now have a confirmed on-chain match', async () => {
    mockDb.fiatOrder.findMany.mockResolvedValue([
      baseOrder({ status: 'PROCESSING' }),
    ])
    mockDb.transaction.findMany.mockResolvedValue([
      {
        id: 'tx-1',
        txHash: '0xabc',
        status: 'CONFIRMED',
        userId: 'user-1',
        amount: 100,
      },
    ])
    // reconcileSingleOrder re-reads the order + tx.
    mockDb.fiatOrder.findUnique.mockResolvedValue(
      baseOrder({ status: 'PROCESSING' })
    )
    mockDb.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 100,
    })
    mockDb.fiatOrder.update.mockImplementation(({ data }: any) => ({
      ...baseOrder(),
      ...data,
    }))

    const res = await reconcileFiatOrders()

    expect(res.scanned).toBe(1)
    expect(res.settled).toBe(1)
  })

  it('alerts when a PROCESSING order is stuck past the stale threshold with no on-chain match', async () => {
    const stale = baseOrder({
      status: 'PROCESSING',
      createdAt: new Date(Date.now() - STALE_ORDER_MAX_AGE_MS - 1000),
    })
    mockDb.fiatOrder.findMany.mockResolvedValue([stale])
    mockDb.transaction.findMany.mockResolvedValue([])

    const res = await reconcileFiatOrders()

    expect(res.settled).toBe(0)
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        component: 'fiat-reconciliation',
      }),
      expect.stringContaining('fiat:stuck:')
    )
  })

  it('does not cross-link two providers concurrent orders for the same user + asset (#313)', async () => {
    // Same user, same asset, two different providers, both PROCESSING with
    // different quoted crypto amounts. Only one on-chain confirmed
    // transaction exists, matching order A's quote — order B must NOT be
    // settled against it even though the old "most recent unlinked" heuristic
    // would have grabbed it.
    const orderA = baseOrder({
      id: 'order-A',
      provider: 'moonpay',
      providerOrderId: 'mp_1',
      status: 'PROCESSING',
      quotedCryptoAmount: 100,
    })
    const orderB = baseOrder({
      id: 'order-B',
      provider: 'sandbox',
      providerOrderId: 'sb_1',
      status: 'PROCESSING',
      quotedCryptoAmount: 50,
    })
    mockDb.fiatOrder.findMany.mockResolvedValue([orderA, orderB])

    const tx = {
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 100, // matches order A within tolerance; way off from order B
    }
    mockDb.transaction.findMany.mockResolvedValue([tx])
    mockDb.fiatOrder.findUnique.mockImplementation(({ where }: any) =>
      where.id === 'order-A' ? orderA : orderB
    )
    mockDb.transaction.findUnique.mockResolvedValue(tx)
    mockDb.fiatOrder.update.mockImplementation(({ where, data }: any) => ({
      id: where.id,
      ...data,
    }))

    const res = await reconcileFiatOrders()

    expect(res.settled).toBe(1)
    const settleCalls = mockDb.fiatOrder.update.mock.calls.filter(
      (c: any) => c[0].data.status === 'SETTLED'
    )
    expect(settleCalls).toHaveLength(1)
    expect(settleCalls[0][0].where.id).toBe('order-A')
  })
})

describe('ageOutStaleFiatOrders', () => {
  it('fails PENDING orders older than the stale threshold', async () => {
    mockDb.fiatOrder.findMany.mockResolvedValue([
      { id: 'order-1' },
      { id: 'order-2' },
    ])
    mockDb.fiatOrder.update.mockResolvedValue({})

    const res = await ageOutStaleFiatOrders()

    expect(res.failed).toBe(2)
    expect(mockDb.fiatOrder.update).toHaveBeenCalledTimes(2)
    const firstData = mockDb.fiatOrder.update.mock.calls[0][0].data
    expect(firstData.status).toBe('FAILED')
  })

  it('does nothing when there are no stale orders', async () => {
    mockDb.fiatOrder.findMany.mockResolvedValue([])
    const res = await ageOutStaleFiatOrders()
    expect(res.failed).toBe(0)
    expect(mockDb.fiatOrder.update).not.toHaveBeenCalled()
  })
})
