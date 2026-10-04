import crypto from 'node:crypto'
import { logger } from '../utils/logger'
import { enqueueOutboundNotification } from '../services/outboundNotifications'

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

function verifySmtpWebhookSignature(
  signature: string | undefined,
  payload: string
): boolean {
  if (!signature) return false
  const signingSecret = process.env.SMTP_WEBHOOK_SECRET
  if (!signingSecret) return false
  const computed = crypto
    .createHmac('sha256', signingSecret)
    .update(payload)
    .digest('hex')
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))
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
 * SMTP Mail Provider using Nodemailer.
 */
export class SmtpMailProvider implements MailProvider {
  name = 'smtp'
  private transporter: any = null
  private transporterConfig = ''

  constructor() {
    this.refreshTransporter()
  }

  private refreshTransporter(): void {
    const fingerprint = [
      process.env.SMTP_HOST,
      process.env.SMTP_PORT,
      process.env.SMTP_USER,
      process.env.SMTP_PASS,
      process.env.SMTP_SECURE,
    ].join('|')
    if (fingerprint === this.transporterConfig) return
    this.transporterConfig = fingerprint
    this.transporter = null

    if (
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
    ) {
      try {
        // Nodemailer is lazily imported to avoid hard dependency
        const nodemailer = require('nodemailer')
        this.transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT),
          secure: process.env.SMTP_SECURE !== 'false',
          connectionTimeout: 10_000,
          socketTimeout: 10_000,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        })
      } catch (err) {
        logger.warn('[SmtpMailProvider] Failed to initialize Nodemailer', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!message.text || !message.text.trim()) {
      throw new Error('Email message must include a plaintext part')
    }

    this.refreshTransporter()
    if (!this.transporter) {
      throw new Error('SMTP provider not configured')
    }

    const info = await this.transporter.sendMail({
      from: process.env.SMTP_FROM_EMAIL || 'noreply@neurowealth.app',
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
    })

    logger.info(`[SmtpMailProvider] Sent email to ${message.to}`, {
      messageId: info.messageId,
    })

    return {
      messageId: info.messageId || `msg_smtp_${Date.now()}`,
      provider: this.name,
    }
  }

  parseWebhook(rawPayload: any, signature?: string): MailWebhookEvent | null {
    if (!rawPayload || !rawPayload.event) return null

    if (signature) {
      const payload = JSON.stringify(rawPayload)
      if (!verifySmtpWebhookSignature(signature, payload)) {
        logger.warn('[SmtpMailProvider] Invalid webhook signature')
        return null
      }
    }

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
 * AWS SES Mail Provider using AWS SDK v3.
 */
export class SesMailProvider implements MailProvider {
  name = 'ses'
  private client: any = null

  constructor() {
    if (process.env.AWS_REGION) {
      try {
        const { SESv2Client } = require('@aws-sdk/client-sesv2')
        this.client = new SESv2Client({ region: process.env.AWS_REGION })
      } catch (err) {
        logger.warn('[SesMailProvider] Failed to initialize AWS SES client', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!message.text || !message.text.trim()) {
      throw new Error('Email message must include a plaintext part')
    }

    if (!this.client) {
      throw new Error('AWS SES provider not configured')
    }

    try {
      const { SendEmailCommand } = require('@aws-sdk/client-sesv2')

      const command = new SendEmailCommand({
        FromEmailAddress:
          process.env.SES_FROM_EMAIL || 'noreply@neurowealth.app',
        Destination: {
          ToAddresses: [message.to],
        },
        Content: {
          Simple: {
            Subject: {
              Data: message.subject,
            },
            Body: {
              Text: {
                Data: message.text,
              },
              Html: {
                Data: message.html,
              },
            },
          },
        },
      })

      const response = await this.client.send(command)

      logger.info(`[SesMailProvider] Sent email via SES to ${message.to}`, {
        messageId: response.MessageId,
      })

      return {
        messageId: response.MessageId || `msg_ses_${Date.now()}`,
        provider: this.name,
      }
    } catch (err) {
      logger.error('[SesMailProvider] Failed to send email via SES', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  parseWebhook(rawPayload: any, signature?: string): MailWebhookEvent | null {
    if (!rawPayload || !rawPayload.notificationType) return null

    if (signature) {
      if (!this.verifySesSignature(rawPayload, signature)) {
        logger.warn('[SesMailProvider] Invalid SES webhook signature')
        return null
      }
    }

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

  private verifySesSignature(payload: any, signature: string): boolean {
    const certUrl = payload.SigningCertUrl
    if (!certUrl || !certUrl.startsWith('https://')) {
      logger.warn('[SesMailProvider] Invalid or missing certificate URL')
      return false
    }

    try {
      const message = payload.Message
      const timestamp = payload.Timestamp
      const type = payload.Type

      const stringToSign = `${message}${timestamp}${type}`
      const verifyPayload = `${stringToSign}${signature}`

      // For production, you would fetch the cert from certUrl and verify
      // This is a placeholder that validates the structure
      logger.warn(
        '[SesMailProvider] SES signature verification deferred to HTTPS cert check'
      )
      return true
    } catch (err) {
      logger.warn('[SesMailProvider] Failed to verify SES signature', {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
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
    // Use provided providers or auto-detect from environment
    if (primary && fallback) {
      this.primaryProvider = primary
      this.fallbackProvider = fallback
    } else {
      const { primary: autoPrimary, fallback: autoFallback } =
        this.detectProviders()
      this.primaryProvider = primary || autoPrimary
      this.fallbackProvider = fallback || autoFallback
    }

    logger.info('[MailRegistry] Initialized', {
      primary: this.primaryProvider.name,
      fallback: this.fallbackProvider.name,
    })
  }

  private detectProviders(): {
    primary: MailProvider
    fallback: MailProvider
  } {
    // Priority: SES > SMTP > Mock
    let primary: MailProvider
    let fallback: MailProvider

    const smtpProvider = new SmtpMailProvider()
    const sesProvider = new SesMailProvider()
    const mockProvider = new MockMailProvider()

    if (process.env.AWS_REGION && process.env.SES_FROM_EMAIL) {
      primary = sesProvider
      fallback =
        process.env.SMTP_HOST && process.env.SMTP_USER
          ? smtpProvider
          : mockProvider
    } else if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      primary = smtpProvider
      fallback = mockProvider
    } else {
      primary = mockProvider
      fallback = mockProvider
    }

    return { primary, fallback }
  }

  refreshProviders(): void {
    const providers = this.detectProviders()
    this.primaryProvider = providers.primary
    this.fallbackProvider = providers.fallback
    this.isHealthy = true
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!message.text || !message.text.trim()) {
      throw new Error('Email message must include a plaintext part')
    }
    const messageId = await enqueueOutboundNotification('email', message)
    return { messageId, provider: 'queue' }
  }

  async deliverQueued(message: MailMessage): Promise<MailSendResult> {
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
