import db from '../../src/db'
import {
  generateUnsubscribeToken,
  getQuietHoursDeferUntil,
  shouldSendNotification,
  verifyUnsubscribeToken,
} from '../../src/notifications/service'

jest.mock('../../src/db', () => ({ __esModule: true, default: {} }))

const mockDb = db as any

describe('unsubscribe tokens', () => {
  beforeEach(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET =
      'test-secret-that-is-long-enough-for-hmac'
  })

  afterEach(() => {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET
  })

  it('rejects a token forged with a different user id', () => {
    const token = generateUnsubscribeToken('user-a')

    expect(verifyUnsubscribeToken(token, 'user-a')).toBe(true)
    expect(verifyUnsubscribeToken(token, 'user-b')).toBe(false)
  })
})

describe('shouldSendNotification & getQuietHoursDeferUntil', () => {
  beforeEach(() => {
    mockDb.notificationPreference = {
      findUnique: jest.fn().mockResolvedValue(null),
    }
  })

  it('returns false and no deferral when preference is disabled', async () => {
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      userId: 'u1',
      channel: 'whatsapp',
      category: 'risk_alerts',
      enabled: false,
      quietHours: {
        enabled: true,
        startHour: 0,
        endHour: 23,
        timezone: 'UTC',
      },
    })

    const now = new Date('2026-07-20T12:00:00.000Z')
    await expect(
      shouldSendNotification('u1', 'whatsapp', 'risk_alerts', now)
    ).resolves.toBe(false)
    await expect(
      getQuietHoursDeferUntil('u1', 'whatsapp', 'risk_alerts', now)
    ).resolves.toBeNull()
  })

  it('returns false and computes end-of-window deferral during overnight quiet hours', async () => {
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      userId: 'u1',
      channel: 'whatsapp',
      category: 'risk_alerts',
      enabled: true,
      quietHours: {
        enabled: true,
        startHour: 22,
        endHour: 6,
        timezone: 'UTC',
      },
    })

    const now = new Date('2026-07-20T23:15:00.000Z')
    await expect(
      shouldSendNotification('u1', 'whatsapp', 'risk_alerts', now)
    ).resolves.toBe(false)
    await expect(
      getQuietHoursDeferUntil('u1', 'whatsapp', 'risk_alerts', now)
    ).resolves.toEqual(new Date('2026-07-21T06:00:00.000Z'))
  })
})
