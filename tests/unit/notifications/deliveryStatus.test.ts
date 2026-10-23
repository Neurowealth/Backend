import { getDeliveryStatus } from '../../../src/notifications/service'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    messageDelivery: { findMany: jest.fn() },
    outboundNotification: { findMany: jest.fn() },
    notificationPreferenceAuditLog: { create: jest.fn() },
  },
}))

const mockDb = db as unknown as {
  messageDelivery: { findMany: jest.Mock }
  outboundNotification: { findMany: jest.Mock }
}

describe('getDeliveryStatus (#699)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('aggregates per-channel delivery state from message_deliveries', async () => {
    mockDb.messageDelivery.findMany.mockResolvedValue([
      {
        channel: 'TELEGRAM',
        category: 'NOTIFICATION',
        status: 'DELIVERED',
        deliveredAt: new Date('2026-10-01T10:00:00Z'),
        updatedAt: new Date('2026-10-01T10:00:00Z'),
        lastError: null,
        attempts: 1,
      },
      {
        channel: 'TELEGRAM',
        category: 'NOTIFICATION',
        status: 'DEAD_LETTER',
        deliveredAt: null,
        updatedAt: new Date('2026-10-02T10:00:00Z'),
        lastError: 'bot blocked',
        attempts: 3,
      },
    ])
    mockDb.outboundNotification.findMany.mockResolvedValue([])

    const result = await getDeliveryStatus('user-1')

    expect(mockDb.messageDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } })
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      userId: 'user-1',
      channel: 'telegram',
      failureCount: 1,
      lastError: 'bot blocked',
    })
    expect(result[0].lastDeliveredAt).toEqual(
      new Date('2026-10-01T10:00:00Z')
    )
  })

  it('returns an empty array when the user has no delivery history', async () => {
    mockDb.messageDelivery.findMany.mockResolvedValue([])
    mockDb.outboundNotification.findMany.mockResolvedValue([])

    await expect(getDeliveryStatus('user-empty')).resolves.toEqual([])
  })
})
