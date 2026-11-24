import dns from 'node:dns'
import {
  enqueueUserWebhooks,
  processUserWebhookDeliveries,
  USER_WEBHOOK_MAX_ATTEMPTS,
  USER_WEBHOOK_MAX_CONSECUTIVE_FAILURES,
} from '../../../src/services/userWebhookDispatcher'
import db from '../../../src/db'

jest.mock('node:dns', () => ({
  promises: {
    lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
}))

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {},
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}))

const mockDb = db as any

describe('userWebhookDispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.userWebhookEndpoint = {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    }
    mockDb.userWebhookDelivery = {
      create: jest.fn().mockResolvedValue({ id: 'del-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    }
    mockDb.userEvent = {
      findFirst: jest.fn().mockResolvedValue(null),
    }
    global.fetch = jest.fn()
  })

  describe('publish and dispatch lifecycle', () => {
    it('publishes an event for a user with an endpoint, runs the dispatcher, and asserts one signed POST and that the row ends as DELIVERED', async () => {
      const userId = 'user-123'
      const endpointId = 'ep-456'
      const endpointUrl = 'https://webhook.site/my-endpoint'
      const endpointSecret = 'super-secret-key'

      const activeEndpoint = {
        id: endpointId,
        userId,
        url: endpointUrl,
        secret: endpointSecret,
        secretHash: 'hashed',
        events: ['transfer.completed'],
        topicScope: ['transfers'],
        filterJson: null,
        status: 'ACTIVE',
        isActive: true,
        consecutiveFailures: 0,
      }

      mockDb.userWebhookEndpoint.findMany.mockResolvedValue([activeEndpoint])

      // 1. Publish/enqueue an event
      const payload = { amount: 100, asset: 'XLM' }
      await enqueueUserWebhooks(
        userId,
        'transfers',
        'transfer.completed',
        1,
        payload
      )

      expect(mockDb.userWebhookDelivery.create).toHaveBeenCalledTimes(1)
      expect(mockDb.userWebhookDelivery.create).toHaveBeenCalledWith({
        data: {
          endpointId,
          userEventSeq: 1,
          eventType: 'transfer.completed',
          payload,
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: expect.any(Date),
        },
      })

      // 2. Setup mock delivery ready for processing
      const pendingDelivery = {
        id: 'del-1',
        endpointId,
        userEventSeq: BigInt(1),
        eventType: 'transfer.completed',
        payload,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
        endpoint: activeEndpoint,
      }

      mockDb.userWebhookDelivery.findMany.mockResolvedValue([pendingDelivery])
      mockDb.userWebhookDelivery.updateMany.mockResolvedValue({ count: 1 })
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
      })

      // 3. Run the dispatcher
      const result = await processUserWebhookDeliveries(50)

      expect(result.processed).toBe(1)
      expect(result.delivered).toBe(1)

      // Assert compare-and-set claim was executed
      expect(mockDb.userWebhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-1', status: 'PENDING' },
        data: { status: 'PROCESSING' },
      })

      // Assert signed POST was made to endpoint URL
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const [fetchUrl, fetchOptions] = (global.fetch as jest.Mock).mock.calls[0]
      expect(fetchUrl).toBe(endpointUrl)
      expect(fetchOptions.method).toBe('POST')
      expect(fetchOptions.headers['X-User-Webhook-Signature']).toMatch(
        /^t=\d+,v1=[a-f0-9]{64}$/
      )
      expect(JSON.parse(fetchOptions.body)).toEqual(payload)

      // Assert row ends as DELIVERED
      expect(mockDb.userWebhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'del-1' },
        data: expect.objectContaining({
          status: 'DELIVERED',
          responseCode: 200,
          attempts: 1,
        }),
      })

      // Assert endpoint consecutiveFailures reset to 0
      expect(mockDb.userWebhookEndpoint.update).toHaveBeenCalledWith({
        where: { id: endpointId },
        data: expect.objectContaining({
          consecutiveFailures: 0,
        }),
      })
    })

    it('retries with exponential backoff on transient failure', async () => {
      const activeEndpoint = {
        id: 'ep-1',
        userId: 'u-1',
        url: 'https://example.com/hook',
        secret: 'sec',
        status: 'ACTIVE',
        isActive: true,
        consecutiveFailures: 0,
      }

      const pendingDelivery = {
        id: 'del-fail-1',
        endpointId: 'ep-1',
        payload: { test: true },
        status: 'PENDING',
        attempts: 1,
        endpoint: activeEndpoint,
      }

      mockDb.userWebhookDelivery.findMany.mockResolvedValue([pendingDelivery])
      mockDb.userWebhookDelivery.updateMany.mockResolvedValue({ count: 1 })
      ;(global.fetch as jest.Mock).mockRejectedValue(new Error('Connection timed out'))

      const result = await processUserWebhookDeliveries(50)

      expect(result.retried).toBe(1)
      expect(mockDb.userWebhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'del-fail-1' },
        data: expect.objectContaining({
          status: 'PENDING',
          attempts: 2,
          nextAttemptAt: expect.any(Date),
          error: 'Connection timed out',
        }),
      })
    })

    it('auto-disables endpoint when consecutive failures exceed threshold', async () => {
      const activeEndpoint = {
        id: 'ep-auto-disable',
        userId: 'u-1',
        url: 'https://example.com/failing',
        secret: 'sec',
        status: 'ACTIVE',
        isActive: true,
        consecutiveFailures: USER_WEBHOOK_MAX_CONSECUTIVE_FAILURES - 1,
      }

      const terminalDelivery = {
        id: 'del-terminal',
        endpointId: 'ep-auto-disable',
        payload: { test: true },
        status: 'PENDING',
        attempts: USER_WEBHOOK_MAX_ATTEMPTS - 1, // Will reach max attempts
        endpoint: activeEndpoint,
      }

      mockDb.userWebhookDelivery.findMany.mockResolvedValue([terminalDelivery])
      mockDb.userWebhookDelivery.updateMany.mockResolvedValue({ count: 1 })
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })

      const result = await processUserWebhookDeliveries(50)

      expect(result.failed).toBe(1)
      expect(mockDb.userWebhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'del-terminal' },
        data: expect.objectContaining({
          status: 'FAILED',
          attempts: USER_WEBHOOK_MAX_ATTEMPTS,
        }),
      })

      // Endpoint auto-disabled
      expect(mockDb.userWebhookEndpoint.update).toHaveBeenCalledWith({
        where: { id: 'ep-auto-disable' },
        data: expect.objectContaining({
          consecutiveFailures: USER_WEBHOOK_MAX_CONSECUTIVE_FAILURES,
          status: 'PAUSED',
          isActive: false,
        }),
      })
    })
  })
})
