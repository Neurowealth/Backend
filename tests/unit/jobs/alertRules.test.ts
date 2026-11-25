// Config env validation runs at import time; supply the required vars before
// any src import loads src/config/env (same pattern as the other unit tests).
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
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32)

import { runAlertRules } from '../../../src/jobs/alertRules'
import db from '../../../src/db'
import { publishUserEvent } from '../../../src/events/publisher'
import { sendWhatsAppMessage } from '../../../src/utils/twilio-client'
import { messageDeliveryService } from '../../../src/messaging'
import { sendPushNotification } from '../../../src/controllers/push-controller'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {},
}))
// #316: alert delivery now goes through the unified publisher, which fans out
// to the user's real-time stream and (when the rule opts in) the webhook leg.
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/utils/twilio-client', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue('sid-1'),
}))
jest.mock('../../../src/controllers/push-controller', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  logBackgroundJob: jest.fn(),
}))
jest.mock('../../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

const mockDb = db as any
const mockPublish = publishUserEvent as jest.Mock
const mockSendWhatsApp = sendWhatsAppMessage as jest.Mock
const mockSendPush = sendPushNotification as jest.Mock

/** Build a fresh alertRule mock with sensible default resolved values. */
function stubDb(rules: any[]): void {
  mockDb.alertRule = {
    findMany: jest.fn().mockResolvedValue(rules),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  mockDb.protocolRate = { findFirst: jest.fn().mockResolvedValue(null) }
  mockDb.position = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.yieldSnapshot = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.user = {
    findUnique: jest.fn().mockResolvedValue({ phone: '+15551230000' }),
  }
  mockDb.notificationPreference = {
    findUnique: jest.fn().mockResolvedValue(null),
  }
  mockDb.outboundNotification = {
    create: jest.fn().mockResolvedValue({ id: 'out-1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  }
}

const NOW = new Date('2026-07-20T12:00:00.000Z')

describe('runAlertRules', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('fires a PROTOCOL_APY webhook when APY drops below the threshold', async () => {
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PROTOCOL_APY',
        protocolName: 'Blend',
        comparator: 'LT',
        threshold: 5, // percent
        deliveryChannel: 'WEBHOOK',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    // supplyApy stored as a fraction: 0.04 == 4% < 5% threshold → fires.
    mockDb.protocolRate.findFirst.mockResolvedValue({ supplyApy: 0.04 })

    await runAlertRules(NOW)

    expect(mockDb.alertRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'rule-1', isActive: true }),
        data: { lastFiredAt: NOW },
      })
    )
    expect(mockPublish).toHaveBeenCalledWith(
      'user-1',
      'alerts',
      'alert_rule.triggered',
      expect.objectContaining({
        ruleId: 'rule-1',
        observedValue: 4,
        threshold: 5,
      }),
      // WEBHOOK/BOTH rules keep the webhook leg; WHATSAPP-only rules publish to
      // the socket alone.
      { webhook: true }
    )
  })

  it('does not fire when the APY condition is not met', async () => {
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PROTOCOL_APY',
        protocolName: 'Blend',
        comparator: 'LT',
        threshold: 5,
        deliveryChannel: 'WEBHOOK',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.protocolRate.findFirst.mockResolvedValue({ supplyApy: 0.08 }) // 8% not < 5%

    await runAlertRules(NOW)

    expect(mockDb.alertRule.updateMany).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('auto-deactivates a PROTOCOL_APY rule whose protocol has no rate data', async () => {
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PROTOCOL_APY',
        protocolName: 'Ghost',
        comparator: 'LT',
        threshold: 5,
        deliveryChannel: 'WEBHOOK',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.protocolRate.findFirst.mockResolvedValue(null) // delisted

    await runAlertRules(NOW)

    expect(mockDb.alertRule.updateMany).toHaveBeenCalledWith({
      where: { id: 'rule-1', deletedAt: null },
      data: { isActive: false },
    })
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('does not deliver when the fire-claim matches 0 rows (deleted/deactivated mid-tick)', async () => {
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PROTOCOL_APY',
        protocolName: 'Blend',
        comparator: 'LT',
        threshold: 5,
        deliveryChannel: 'WEBHOOK',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.protocolRate.findFirst.mockResolvedValue({ supplyApy: 0.04 })
    // Claim loses (rule deleted/deactivated or already fired concurrently).
    mockDb.alertRule.updateMany.mockResolvedValue({ count: 0 })

    await runAlertRules(NOW)

    expect(mockPublish).not.toHaveBeenCalled()
    expect(mockSendWhatsApp).not.toHaveBeenCalled()
  })

  it('delivers over both channels for a BOTH rule and includes WhatsApp when a phone is on file', async () => {
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PORTFOLIO_VALUE',
        protocolName: null,
        comparator: 'LT',
        threshold: 1000,
        deliveryChannel: 'BOTH',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.position.findMany.mockResolvedValue([{ currentValue: 500 }]) // < 1000

    await runAlertRules(NOW)

    expect(mockPublish).toHaveBeenCalledTimes(1)
    expect(mockSendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+15551230000' })
    )
  })

  it('skips the WhatsApp channel (without error) when the user has no phone', async () => {
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PORTFOLIO_VALUE',
        protocolName: null,
        comparator: 'LT',
        threshold: 1000,
        deliveryChannel: 'WHATSAPP',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.position.findMany.mockResolvedValue([{ currentValue: 500 }])
    mockDb.user.findUnique.mockResolvedValue({ phone: null })

    await runAlertRules(NOW)

    expect(mockSendWhatsApp).not.toHaveBeenCalled()
  })

  it('rolls back the fire-claim when delivery hard-fails so it retries next tick', async () => {
    const prior = new Date('2026-07-20T10:00:00.000Z')
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PORTFOLIO_VALUE',
        protocolName: null,
        comparator: 'LT',
        threshold: 1000,
        deliveryChannel: 'WEBHOOK',
        cooldownMinutes: 60,
        lastFiredAt: prior,
      },
    ])
    mockDb.position.findMany.mockResolvedValue([{ currentValue: 500 }])
    mockPublish.mockRejectedValueOnce(new Error('delivery boom'))

    await runAlertRules(NOW)

    // First call claims (lastFiredAt=NOW); rollback restores the prior value.
    expect(mockDb.alertRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastFiredAt: prior } })
    )
  })

  it('skips messageDeliveryService.send when whatsapp/risk_alerts preference is disabled while still publishing the real-time event', async () => {
    const sendSpy = jest.spyOn(messageDeliveryService, 'send')
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PORTFOLIO_VALUE',
        protocolName: null,
        comparator: 'LT',
        threshold: 1000,
        deliveryChannel: 'WHATSAPP',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.position.findMany.mockResolvedValue([{ currentValue: 500 }])
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      userId: 'user-1',
      channel: 'whatsapp',
      category: 'risk_alerts',
      enabled: false,
    })

    await runAlertRules(NOW)

    expect(mockPublish).toHaveBeenCalledTimes(1)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockSendWhatsApp).not.toHaveBeenCalled()
    sendSpy.mockRestore()
  })

  it('defers WhatsApp alert delivery during quiet hours instead of sending immediately or dropping', async () => {
    const sendSpy = jest
      .spyOn(messageDeliveryService, 'send')
      .mockResolvedValue({} as any)
    stubDb([
      {
        id: 'rule-1',
        userId: 'user-1',
        metric: 'PORTFOLIO_VALUE',
        protocolName: null,
        comparator: 'LT',
        threshold: 1000,
        deliveryChannel: 'WHATSAPP',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.position.findMany.mockResolvedValue([{ currentValue: 500 }])
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      userId: 'user-1',
      channel: 'whatsapp',
      category: 'risk_alerts',
      enabled: true,
      quietHours: {
        enabled: true,
        startHour: 10,
        endHour: 15,
        timezone: 'UTC',
      },
    })

    // NOW is 12:00 UTC, inside 10:00-15:00 quiet hours.
    await runAlertRules(NOW)

    expect(mockPublish).toHaveBeenCalledTimes(1)
    expect(mockSendWhatsApp).not.toHaveBeenCalled()
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'WHATSAPP',
        userId: 'user-1',
        nextAttemptAt: new Date('2026-07-20T15:00:00.000Z'),
      }),
      { immediate: false }
    )
    sendSpy.mockRestore()
  })

  it('skips push notification when push/risk_alerts is disabled and defers during quiet hours', async () => {
    stubDb([
      {
        id: 'rule-push',
        userId: 'user-1',
        metric: 'PORTFOLIO_VALUE',
        protocolName: null,
        comparator: 'LT',
        threshold: 1000,
        deliveryChannel: 'PUSH',
        cooldownMinutes: 60,
        lastFiredAt: null,
      },
    ])
    mockDb.position.findMany.mockResolvedValue([{ currentValue: 500 }])
    mockDb.notificationPreference.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      channel: 'push',
      category: 'risk_alerts',
      enabled: false,
    })

    await runAlertRules(NOW)

    expect(mockPublish).toHaveBeenCalledTimes(1)
    expect(mockSendPush).not.toHaveBeenCalled()
    expect(mockDb.outboundNotification.create).not.toHaveBeenCalled()

    // Now test quiet hours deferral for push.
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      userId: 'user-1',
      channel: 'push',
      category: 'risk_alerts',
      enabled: true,
      quietHours: {
        enabled: true,
        startHour: 10,
        endHour: 15,
        timezone: 'UTC',
      },
    })

    await runAlertRules(NOW)

    expect(mockSendPush).not.toHaveBeenCalled()
    expect(mockDb.outboundNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: 'push',
        nextAttemptAt: new Date('2026-07-20T15:00:00.000Z'),
      }),
    })
  })
})
