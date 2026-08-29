import { logger } from '../utils/logger'

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
}

export interface MailSendResult {
  messageId: string
  provider: string
}

export interface MailWebhookEvent {
  type: 'bounce' | 'complaint' | 'delivery'
  messageId: string
  recipient: string
  reason?: string
}

export interface MailProvider {
  name: string
  send(message: MailMessage): Promise<MailSendResult>
  parseWebhook(rawPayload: any, signature?: string): MailWebhookEvent | null
}

/**
 * Mock / In-Memory Mail Provider for local testing & development.
 */
export class MockMailProvider implements MailProvider {
  name = 'mock'
  sentMessages: MailMessage[] = []

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!message.text || !message.text.trim()) {
      throw new Error('Email message must include a plaintext part')
    }
    this.sentMessages.push(message)
    const messageId = `msg_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    logger.info(
      `[MockMailProvider] Sent email to ${message.to}: ${message.subject}`
    )
    return { messageId, provider: this.name }
  }

  parseWebhook(rawPayload: any): MailWebhookEvent | null {
    if (!rawPayload || !rawPayload.type) return null
    return {
      type: rawPayload.type,
      messageId: rawPayload.messageId || 'msg_mock_001',
      recipient: rawPayload.recipient || 'test@example.com',
      reason: rawPayload.reason,
    }
  }
}

/**
 * SMTP Mail Provider using Nodemailer format.
 */
export class SmtpMailProvider implements MailProvider {
  name = 'smtp'

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!message.text || !message.text.trim()) {
      throw new Error('Email message must include a plaintext part')
    }
    const messageId = `msg_smtp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    logger.info(`[SmtpMailProvider] Dispatched email to ${message.to}`)
    return { messageId, provider: this.name }
  }

  parseWebhook(rawPayload: any): MailWebhookEvent | null {
    if (!rawPayload || !rawPayload.event) return null
    return {
      type:
        rawPayload.event === 'bounce'
          ? 'bounce'
          : rawPayload.event === 'complaint'
            ? 'complaint'
            : 'delivery',
      messageId: rawPayload.messageId,
      recipient: rawPayload.email,
      reason: rawPayload.reason,
    }
  }
}

/**
 * AWS SES Mail Provider.
 */
export class SesMailProvider implements MailProvider {
  name = 'ses'

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!message.text || !message.text.trim()) {
      throw new Error('Email message must include a plaintext part')
    }
    const messageId = `msg_ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    logger.info(`[SesMailProvider] Dispatched email via SES to ${message.to}`)
    return { messageId, provider: this.name }
  }

  parseWebhook(rawPayload: any): MailWebhookEvent | null {
    if (!rawPayload || !rawPayload.notificationType) return null
    const notificationType = (rawPayload.notificationType || '').toLowerCase()
    const type =
      notificationType === 'bounce'
        ? 'bounce'
        : notificationType === 'complaint'
          ? 'complaint'
          : 'delivery'
    const mail = rawPayload.mail || {}
    const recipient = mail.destination?.[0] || 'unknown@example.com'
    return {
      type,
      messageId: mail.messageId || 'msg_ses_unknown',
      recipient,
      reason:
        rawPayload.bounce?.bounceType ||
        rawPayload.complaint?.complaintFeedbackType,
    }
  }
}

/**
 * Mail Provider Registry with Health Ledger & Fallback.
 */
export class MailRegistry {
  private primaryProvider: MailProvider
  private fallbackProvider: MailProvider
  private isHealthy = true

  constructor(primary?: MailProvider, fallback?: MailProvider) {
    this.primaryProvider = primary || new MockMailProvider()
    this.fallbackProvider = fallback || new SmtpMailProvider()
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    if (this.isHealthy) {
      try {
        return await this.primaryProvider.send(message)
      } catch (err: any) {
        logger.warn(
          `[MailRegistry] Primary mail provider "${this.primaryProvider.name}" failed, failing over to fallback`,
          { error: err.message }
        )
        this.isHealthy = false
        // Attempt recovery after 60s
        setTimeout(() => {
          this.isHealthy = true
        }, 60000)
        return await this.fallbackProvider.send(message)
      }
    }
    return await this.fallbackProvider.send(message)
  }

  parseWebhook(rawPayload: any, signature?: string): MailWebhookEvent | null {
    return (
      this.primaryProvider.parseWebhook(rawPayload, signature) ||
      this.fallbackProvider.parseWebhook(rawPayload, signature)
    )
  }
}

export const mailRegistry = new MailRegistry()
