import { dispatchWebhookEvent } from '../../../src/services/webhookDispatcher'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {},
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

const mockDb = db as any

describe('webhookDispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Default: no subscriptions
    mockDb.webhookSubscription = {
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.webhookDelivery = {
      create: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
      update: jest.fn().mockResolvedValue({}),
    }
    // Reset global fetch mock
    global.fetch = jest.fn()
  })

  describe('dispatchWebhookEvent', () => {
    it('does nothing when there are no matching subscriptions', async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([])
      await dispatchWebhookEvent('deposit.received', { amount: '100' })
      expect(mockDb.webhookDelivery.create).not.toHaveBeenCalled()
    })

    it('creates a delivery record and marks it SUCCESS on first attempt', async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', url: 'https://example.com/wh', secret: 'mysecret' },
      ])
      ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 })

      await dispatchWebhookEvent('deposit.received', { amount: '100' })

      expect(mockDb.webhookDelivery.create).toHaveBeenCalledTimes(1)
      expect(mockDb.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SUCCESS', attempts: 1 }),
        })
      )
    })

    it('retries up to 3 times and marks FAILED after all attempts fail', async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', url: 'https://example.com/wh', secret: 'mysecret' },
      ])
      ;(global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'))

      // Patch setTimeout to avoid real delays in tests
      jest.useFakeTimers()
      const dispatchPromise = dispatchWebhookEvent('deposit.received', {
        amount: '100',
      })
      // Advance through all exponential back-off delays (1s, 2s)
      await jest.runAllTimersAsync()
      await dispatchPromise
      jest.useRealTimers()

      // fetch called 3 times (MAX_ATTEMPTS)
      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(mockDb.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED', attempts: 3 }),
        })
      )
    })

    it('succeeds on the second attempt after a transient failure', async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', url: 'https://example.com/wh', secret: 'mysecret' },
      ])
      ;(global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ ok: true, status: 200 })

      jest.useFakeTimers()
      const dispatchPromise = dispatchWebhookEvent('deposit.received', {
        amount: '100',
      })
      await jest.runAllTimersAsync()
      await dispatchPromise
      jest.useRealTimers()

      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(mockDb.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SUCCESS', attempts: 2 }),
        })
      )
    })

    it('sends X-Neurowealth-Signature header with sha256= prefix', async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', url: 'https://example.com/wh', secret: 'mysecret' },
      ])
      ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 })

      await dispatchWebhookEvent('agent.rebalanced', { protocol: 'anchor' })

      const [, options] = (global.fetch as jest.Mock).mock.calls[0]
      expect(
        (options.headers as Record<string, string>)['X-Neurowealth-Signature']
      ).toMatch(/^sha256=[0-9a-f]{64}$/)
    })

    it('queries subscriptions filtered by event type', async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([])

      await dispatchWebhookEvent('agent.rebalanced', {})

      expect(mockDb.webhookSubscription.findMany).toHaveBeenCalledWith({
        where: { isActive: true, events: { has: 'agent.rebalanced' } },
      })
    })
  })
})
