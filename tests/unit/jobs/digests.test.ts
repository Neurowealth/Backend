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

import db from '../../../src/db'
import { runDigests } from '../../../src/jobs/digests'
import { sendWhatsAppMessage } from '../../../src/utils/twilio-client'
import { publishUserEvent } from '../../../src/events/publisher'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/twilio-client', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue('sid-1'),
}))
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/notifications/load', () => ({
  loadDigestData: jest.fn().mockResolvedValue({
    period: {
      label: 'Past 7 days',
      startAt: new Date('2026-07-13T12:00:00.000Z'),
      endAt: new Date('2026-07-20T12:00:00.000Z'),
    },
    positions: [],
    snapshots: [],
    transactions: [],
    rebalances: [],
    goals: [],
    caveats: [],
    notableTxnThreshold: 100,
  }),
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
const mockSendWhatsApp = sendWhatsAppMessage as jest.Mock
const mockPublish = publishUserEvent as jest.Mock

const NOW = new Date('2026-07-20T12:00:00.000Z')

function stubDigestSub(overrides: Record<string, unknown> = {}): void {
  const sub = {
    id: 'sub-1',
    userId: 'user-1',
    frequency: 'WEEKLY',
    channels: ['WHATSAPP', 'WEBHOOK'],
    sendHourUtc: 12,
    weeklyDayUtc: 1,
    quietHours: null,
    isActive: true,
    lastSentAt: null,
    nextRunAt: NOW,
    ...overrides,
  }
  mockDb.digestSubscription = {
    findMany: jest.fn().mockResolvedValue([sub]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn().mockResolvedValue(sub),
  }
  mockDb.user = {
    findUnique: jest.fn().mockResolvedValue({ phone: '+15551230000' }),
  }
  mockDb.notificationPreference = {
    findUnique: jest.fn().mockResolvedValue(null),
  }
}

describe('runDigests notification preference gating', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('skips WhatsApp digest delivery when whatsapp/portfolio_updates is disabled while keeping WEBHOOK', async () => {
    stubDigestSub()
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      userId: 'user-1',
      channel: 'whatsapp',
      category: 'portfolio_updates',
      enabled: false,
    })

    await runDigests(NOW)

    expect(mockSendWhatsApp).not.toHaveBeenCalled()
    expect(mockPublish).toHaveBeenCalledTimes(1)
  })

  it('defers digest execution when NotificationPreference quiet hours are active', async () => {
    stubDigestSub({ channels: ['WHATSAPP'] })
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      userId: 'user-1',
      channel: 'whatsapp',
      category: 'portfolio_updates',
      enabled: true,
      quietHours: {
        enabled: true,
        startHour: 10,
        endHour: 15,
        timezone: 'UTC',
      },
    })

    await runDigests(NOW)

    expect(mockSendWhatsApp).not.toHaveBeenCalled()
    expect(mockDb.digestSubscription.updateMany).not.toHaveBeenCalled()
    expect(mockDb.digestSubscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { nextRunAt: new Date('2026-07-20T15:00:00.000Z') },
    })
  })
})
