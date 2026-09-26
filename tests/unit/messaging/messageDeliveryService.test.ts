process.env.NODE_ENV = 'test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)
process.env.WHATSAPP_FROM = 'whatsapp:+14155238886'

import {
  MessageDeliveryService,
  messageDeliveryService,
} from '../../../src/messaging/service'
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
      jest.spyOn(twilioClient, 'sendWhatsAppMessage').mockResolvedValue('SM-twilio-sid-1')

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
      const transientError = new telegramClient.TelegramApiError('Rate limited', {
        statusCode: 429,
        retryAfterSeconds: 5,
        isTransient: true,
      })
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockRejectedValue(transientError)

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
      jest.spyOn(twilioClient, 'sendWhatsAppMessage').mockRejectedValue(
        new Error('21211: Invalid phone number')
      )
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
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockRejectedValue(terminalErr)

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
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockRejectedValueOnce(
        new Error('Fatal failure')
      )

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
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockRejectedValue(new Error('Down'))

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

      const result = await messageDeliveryService.retryAllDeadLetters('TELEGRAM')
      expect(result.count).toBe(2)
    })

    it('cancels an unsent or dead-letter message safely', async () => {
      jest.spyOn(telegramClient, 'sendTelegramMessage').mockRejectedValueOnce(new Error('Down'))

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

      const onlyTelegram = await messageDeliveryService.listMessages({ channel: 'TELEGRAM' })
      expect(onlyTelegram.total).toBe(1)
      expect(onlyTelegram.messages[0].channel).toBe('TELEGRAM')

      const onlyAlerts = await messageDeliveryService.listMessages({ category: 'ALERT' })
      expect(onlyAlerts.total).toBe(1)
      expect(onlyAlerts.messages[0].category).toBe('ALERT')
    })
  })
})
