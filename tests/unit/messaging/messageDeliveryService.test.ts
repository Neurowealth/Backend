process.env.NODE_ENV = 'test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)
process.env.WHATSAPP_FROM = 'whatsapp:+14155238886'

import {
  MessageDeliveryService,
  messageDeliveryService,
} from '../../../src/messaging/service'
import db from '../../../src/db'
import type { MessageDeliveryRecord } from '../../../src/messaging/types'
import * as telegramClient from '../../../src/utils/telegram-client'
import * as twilioClient from '../../../src/utils/twilio-client'
import { alertingService } from '../../../src/services/alerting'

jest.mock('../../../src/services/alerting', () => ({
  alertingService: {
    emit: jest.fn().mockResolvedValue(undefined),
  },
}))

describe('MessageDeliveryService (#493)', () => {
  beforeEach(() => {
    messageDeliveryService.clearStoreForTests()
    jest.restoreAllMocks()
  })

  describe('Delivery Status Tracking', () => {
    it('tracks successful Telegram message delivery with provider message ID', async () => {
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockResolvedValue({
        ok: true,
        messageId: 'tlg-msg-12345',
      })

      const record = await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '123456789',
        body: 'Hello via Telegram',
        category: 'NOTIFICATION',
      })

      expect(record.status).toBe('DELIVERED')
      expect(record.providerMessageId).toBe('tlg-msg-12345')
      expect(record.deliveredAt).toBeInstanceOf(Date)
      expect(record.attempts).toBe(1)
      expect(record.lastError).toBeNull()

      const retrieved = await messageDeliveryService.getMessage(record.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.status).toBe('DELIVERED')
    })

    it('tracks successful WhatsApp message delivery with Twilio SID', async () => {
      jest
        .spyOn(twilioClient, 'sendWhatsAppMessage')
        .mockResolvedValue('SM-twilio-sid-1')

      const record = await messageDeliveryService.send({
        channel: 'WHATSAPP',
        recipient: '+15551234567',
        body: 'Hello via WhatsApp',
        category: 'ALERT',
      })

      expect(record.status).toBe('DELIVERED')
      expect(record.providerMessageId).toBe('SM-twilio-sid-1')
      expect(record.attempts).toBe(1)
      expect(record.deliveredAt).toBeInstanceOf(Date)
    })
  })

  describe('Retry Policy & Backoff', () => {
    it('re-enqueues message for retry on transient failure with exponential backoff', async () => {
      const transientError = new telegramClient.TelegramApiError(
        'Rate limited',
        {
          statusCode: 429,
          retryAfterSeconds: 5,
          isTransient: true,
        }
      )
      jest
        .spyOn(telegramClient, 'sendTelegramMessage')
        .mockRejectedValue(transientError)

      const record = await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '123456789',
        body: 'Test retry',
        maxAttempts: 3,
      })

      expect(record.status).toBe('PENDING')
      expect(record.attempts).toBe(1)
      expect(record.nextAttemptAt).toBeInstanceOf(Date)
      expect(record.lastError).toContain('Rate limited')
    })

    it('computes exponential jittered backoff respecting retry_after', () => {
      const backoffWithHeader = messageDeliveryService.calculateBackoff(1, 10)
      expect(backoffWithHeader).toBe(10000)

      const backoffAttempt1 = messageDeliveryService.calculateBackoff(1)
      expect(backoffAttempt1).toBeGreaterThanOrEqual(50)
    })
  })

  describe('Fallback Handling', () => {
    it('triggers fallback channel when primary channel fails and fallback is configured', async () => {
      // Primary fails with terminal error
      jest
        .spyOn(twilioClient, 'sendWhatsAppMessage')
        .mockRejectedValue(new Error('21211: Invalid phone number'))
      // Fallback succeeds
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockResolvedValue({
        ok: true,
        messageId: 'tlg-fallback-id',
      })

      const record = await messageDeliveryService.send({
        channel: 'WHATSAPP',
        recipient: '+15550000000',
        body: 'Security Alert',
        fallbackChannel: 'TELEGRAM',
        fallbackRecipient: '987654321',
      })

      expect(record.status).toBe('DELIVERED')
      expect(record.fallbackTriggered).toBe(true)
      expect(record.fallbackChannel).toBe('TELEGRAM')
      expect(record.fallbackRecipient).toBe('987654321')
      expect(record.providerMessageId).toBe('tlg-fallback-id')
    })
  })

  describe('Dead Letter Queue & Alerting', () => {
    it('moves to DEAD_LETTER and emits alert when attempts and fallback are exhausted', async () => {
      const terminalErr = new Error('403: Forbidden - bot blocked by user')
      jest
        .spyOn(telegramClient, 'sendTelegramMessage')
        .mockRejectedValue(terminalErr)

      const emitSpy = jest.spyOn(alertingService, 'emit')

      const record = await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '123456789',
        body: 'Test failure',
        maxAttempts: 1,
      })

      expect(record.status).toBe('DEAD_LETTER')
      expect(record.lastError).toContain('bot blocked by user')
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'warning',
          component: 'messaging',
          title: expect.stringContaining('Dead-Lettered'),
        }),
        expect.stringContaining('dead_letter:')
      )
    })
  })

  describe('Safe Manual Recovery', () => {
    it('retries a dead-lettered message manually', async () => {
      // First attempt fails to DEAD_LETTER
      jest
        .spyOn(telegramClient, 'sendTelegramMessage')
        .mockRejectedValueOnce(new Error('Fatal failure'))

      const record = await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '123456789',
        body: 'Manual recovery test',
        maxAttempts: 1,
      })

      expect(record.status).toBe('DEAD_LETTER')

      // Now manual retry succeeds
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockResolvedValueOnce({
        ok: true,
        messageId: 'recovered-123',
      })

      const recovered = await messageDeliveryService.retryMessage(record.id)
      expect(recovered.status).toBe('DELIVERED')
      expect(recovered.providerMessageId).toBe('recovered-123')
    })

    it('bulk retries all dead-lettered messages', async () => {
      // Seed 2 dead letter records
      jest
        .spyOn(telegramClient, 'sendTelegramMessage')
        .mockRejectedValue(new Error('Down'))

      await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '111',
        body: 'msg1',
        maxAttempts: 1,
      })
      await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '222',
        body: 'msg2',
        maxAttempts: 1,
      })

      const stats = await messageDeliveryService.getMessageStats()
      expect(stats.byStatus.deadLetter).toBe(2)

      const result =
        await messageDeliveryService.retryAllDeadLetters('TELEGRAM')
      expect(result.count).toBe(2)
    })

    it('cancels an unsent or dead-letter message safely', async () => {
      jest
        .spyOn(telegramClient, 'sendTelegramMessage')
        .mockRejectedValueOnce(new Error('Down'))

      const record = await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '111',
        body: 'to cancel',
        maxAttempts: 1,
      })

      const cancelled = await messageDeliveryService.cancelMessage(record.id)
      expect(cancelled.status).toBe('FAILED')
      expect(cancelled.lastError).toContain('Cancelled by administrator')
    })

    it('lists and filters messages accurately', async () => {
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockResolvedValue({
        ok: true,
        messageId: 'm1',
      })
      jest.spyOn(twilioClient, 'sendWhatsAppMessage').mockResolvedValue('m2')

      await messageDeliveryService.send({
        channel: 'TELEGRAM',
        recipient: '111',
        body: 'Telegram msg',
        category: 'BOT_REPLY',
      })
      await messageDeliveryService.send({
        channel: 'WHATSAPP',
        recipient: '+15551112222',
        body: 'WhatsApp msg',
        category: 'ALERT',
      })

      const all = await messageDeliveryService.listMessages()
      expect(all.total).toBe(2)

      const onlyTelegram = await messageDeliveryService.listMessages({
        channel: 'TELEGRAM',
      })
      expect(onlyTelegram.total).toBe(1)
      expect(onlyTelegram.messages[0].channel).toBe('TELEGRAM')

      const onlyAlerts = await messageDeliveryService.listMessages({
        category: 'ALERT',
      })
      expect(onlyAlerts.total).toBe(1)
      expect(onlyAlerts.messages[0].category).toBe('ALERT')
    })
  })
})

describe('Message delivery queue claims', () => {
  type Delegate = typeof db.messageDelivery
  const delegate: {
    [Method in 'create' | 'findMany' | 'findUnique' | 'updateMany']: (
      ...args: Parameters<Delegate[Method]>
    ) => Promise<Awaited<ReturnType<Delegate[Method]>>>
  } = db.messageDelivery
  let rows: Map<string, MessageDeliveryRecord>
  const input = {
    channel: 'TELEGRAM' as const,
    recipient: 'chat-id',
    body: 'queued message',
  }

  beforeEach(() => {
    rows = new Map()
    messageDeliveryService.clearStoreForTests()
    jest.spyOn(delegate, 'create').mockImplementation(async ({ data }) => {
      const row = { ...data } as MessageDeliveryRecord
      rows.set(row.id, row)
      return row as Awaited<ReturnType<typeof delegate.create>>
    })
    jest
      .spyOn(delegate, 'findMany')
      .mockImplementation(
        async () =>
          [...rows.values()]
            .filter((row) => row.status === 'PENDING')
            .map((row) => ({ ...row })) as Awaited<
            ReturnType<typeof delegate.findMany>
          >
      )
    jest.spyOn(delegate, 'findUnique').mockResolvedValue(null)
    jest
      .spyOn(delegate, 'updateMany')
      .mockImplementation(async ({ where, data }) => {
        let count = 0
        for (const row of rows.values()) {
          if (where?.id !== undefined && row.id !== where.id) continue
          if (row.status !== where?.status) continue
          if (
            where?.updatedAt instanceof Date &&
            row.updatedAt.getTime() !== where.updatedAt.getTime()
          )
            continue
          if (
            where?.updatedAt &&
            typeof where.updatedAt === 'object' &&
            'lt' in where.updatedAt &&
            where.updatedAt.lt instanceof Date &&
            row.updatedAt >= where.updatedAt.lt
          )
            continue
          Object.assign(row, data)
          count++
        }
        return { count }
      })
    jest
      .spyOn(messageDeliveryService, 'refreshQueueMetrics')
      .mockResolvedValue(undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it('sends each queued message once when two sweeps read the same rows', async () => {
    const send = jest
      .spyOn(telegramClient, 'sendTelegramMessage')
      .mockResolvedValue({ ok: true, messageId: 'provider-id' })
    await messageDeliveryService.send(input, { immediate: false })
    const results = await Promise.all([
      messageDeliveryService.processPendingQueue(),
      messageDeliveryService.processPendingQueue(),
    ])

    expect(send).toHaveBeenCalledTimes(1)
    expect(results.map(({ processed }) => processed).sort()).toEqual([0, 1])
  })

  it('retries a stale claim and leaves a recent claim in flight', async () => {
    const send = jest
      .spyOn(telegramClient, 'sendTelegramMessage')
      .mockResolvedValue({ ok: true, messageId: 'provider-id' })
    const stale = await messageDeliveryService.send(input, { immediate: false })
    const fresh = await messageDeliveryService.send(input, { immediate: false })
    rows.set(stale.id, {
      ...stale,
      status: 'SENDING',
      updatedAt: new Date(Date.now() - 6 * 60_000),
    })
    rows.set(fresh.id, { ...fresh, status: 'SENDING' })

    await expect(
      messageDeliveryService.processPendingQueue()
    ).resolves.toMatchObject({
      processed: 1,
      delivered: 1,
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(rows.get(stale.id)?.status).toBe('DELIVERED')
    expect(rows.get(fresh.id)?.status).toBe('SENDING')
  })

  it('keeps production messages out of the in-memory store', async () => {
    jest
      .spyOn(telegramClient, 'sendTelegramMessage')
      .mockResolvedValue({ ok: true, messageId: 'provider-id' })
    const env = process.env
    process.env = { ...env, NODE_ENV: 'production' }
    try {
      const messages = await Promise.all(
        Array.from({ length: 100 }, () => messageDeliveryService.send(input))
      )
      expect(rows.size).toBe(100)
      expect(messages.every((record) => record.status === 'DELIVERED')).toBe(
        true
      )
      const results = await Promise.all(
        messages.map(({ id }) => messageDeliveryService.getMessage(id))
      )
      expect(results.every((record) => record === null)).toBe(true)
    } finally {
      process.env = env
    }
  })
})
