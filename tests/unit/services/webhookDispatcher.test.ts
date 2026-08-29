import { dispatchWebhookEvent } from '../../../src/services/webhookDispatcher'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {},
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))
jest.mock('../../../src/services/webhookCircuitBreaker', () => ({
  isSubscriptionDeliverable: jest.fn().mockReturnValue(true),
  recordDeliverySuccess: jest.fn(),
  recordDeliveryFailure: jest.fn(),
  recordHalfOpenProbe: jest.fn(),
  getSubscriptionHealth: jest.fn().mockReturnValue({
    state: 'closed',
    consecutiveFailures: 0,
    shouldAutoDisable: false,
  }),
}))

const mockDb = db as any
const MAX_ATTEMPTS = 6

describe('webhookDispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.WEBHOOK_MAX_ATTEMPTS
    // Default: no subscriptions
    mockDb.webhookSubscription = {
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.webhookDelivery = {
      create: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
      update: jest.fn().mockResolvedValue({}),
    }
    mockDb.webhookDeadLetter = {
      create: jest.fn().mockResolvedValue({ id: 'dl-1' }),
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

    it(`retries up to ${MAX_ATTEMPTS} times and marks FAILED after all attempts fail`, async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', url: 'https://example.com/wh', secret: 'mysecret' },
      ])
      ;(global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'))

      // Patch setTimeout to avoid real delays in tests
      jest.useFakeTimers()
      const dispatchPromise = dispatchWebhookEvent('deposit.received', {
        amount: '100',
      })
      await jest.runAllTimersAsync()
      await dispatchPromise
      jest.useRealTimers()

      expect(global.fetch).toHaveBeenCalledTimes(MAX_ATTEMPTS)
      expect(mockDb.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            attempts: MAX_ATTEMPTS,
          }),
        })
      )
      expect(mockDb.webhookDeadLetter.create).toHaveBeenCalled()
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

    it('sends v2 webhook signature headers', async () => {
      mockDb.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', url: 'https://example.com/wh', secret: 'mysecret' },
      ])
      ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 })

      await dispatchWebhookEvent('agent.rebalanced', { protocol: 'anchor' })

      const [, options] = (global.fetch as jest.Mock).mock.calls[0]
      const headers = options.headers as Record<string, string>
      expect(headers['X-NW-Webhook-Signature']).toMatch(
        /^v2,[0-9a-f]{64}( v1,[0-9a-f]{64})?$/
      )
      expect(headers['X-NW-Webhook-Id']).toBeDefined()
      expect(headers['X-NW-Webhook-Timestamp']).toBeDefined()
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
