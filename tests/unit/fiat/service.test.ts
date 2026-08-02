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

describe('reconcileFiatOrders', () => {
  it('settles PROCESSING orders that now have a confirmed on-chain match', async () => {
    mockDb.fiatOrder.findMany.mockResolvedValue([
      baseOrder({ status: 'PROCESSING' }),
    ])
    mockDb.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
      userId: 'user-1',
      amount: 100,
    })
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
    mockDb.transaction.findFirst.mockResolvedValue(null)

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
