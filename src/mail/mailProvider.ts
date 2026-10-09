import crypto from 'node:crypto'
import { logger } from '../utils/logger'
import { enqueueOutboundNotification } from '../services/outboundNotifications'
import { mailWebhookRejectionsTotal } from '../utils/metrics'
import {
  createSnsSignatureVerifier,
  isSnsEnvelope,
  type SnsRejectionReason,
  type SnsSignatureVerifier,
} from './snsSignature'

/**
 * Raised when a payload addressed to the SES webhook fails SNS signature
 * verification (#524). The controller maps this to HTTP 401 and never
 * processes the payload — a spoofed or tampered delivery is rejected as
 * unauthenticated, not as malformed (400) and not served.
 *
 * `code` is a plain string marker so a consumer can detect the class without
 * importing it (the module may be mocked under test).
 */
export class SesSignatureVerificationError extends Error {
  readonly code = 'SES_WEBHOOK_SIGNATURE_INVALID'
  readonly reason: SnsRejectionReason

  constructor(reason: SnsRejectionReason) {
    super(`SES webhook failed SNS signature verification (${reason})`)
    this.name = 'SesSignatureVerificationError'
    this.reason = reason
  }
}

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
  [key: string]: unknown
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
  parseWebhook(
    rawPayload: any,
    signature?: string
  ): MailWebhookEvent | null | Promise<MailWebhookEvent | null>
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
 *
 * SES notifications arrive as SNS envelopes (see `snsSignature.ts`). The old
 * behaviour — "any plausible body is genuine" — is gone: every delivery is
 * cryptographically verified, and the SES notification rides inside the SNS
 * `Message` field, which this provider unwraps before mapping (#524).
 */
export class SesMailProvider implements MailProvider {
  name = 'ses'
  private client: any = null
  private readonly snsVerifier: SnsSignatureVerifier

  constructor(options: { snsVerifier?: SnsSignatureVerifier } = {}) {
    this.snsVerifier = options.snsVerifier ?? createSnsSignatureVerifier()

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

  async parseWebhook(
    rawPayload: any,
    signature?: string
  ): Promise<MailWebhookEvent | null> {
    if (!rawPayload || typeof rawPayload !== 'object') return null

    // SES never posts its notification JSON directly — it posts an SNS
    // envelope signed by AWS (#524). A body that lacks the envelope (no
    // `Type` + `Signature`) has no verifiable provenance and is rejected as
    // unauthenticated rather than trusted because it looks plausible.
    if (!isSnsEnvelope(rawPayload)) {
      this.rejectWebhook('missing_signing_fields')
      throw new SesSignatureVerificationError('missing_signing_fields')
    }

    const outcome = await this.snsVerifier.verify(rawPayload)
    if (!outcome.ok) {
      this.rejectWebhook(outcome.reason)
      throw new SesSignatureVerificationError(outcome.reason)
    }
    // The SNS envelope's `Message` carries the SES notification JSON: the
    // pieces we map from (notificationType, mail, bounce/complaint) live
    // there, not on the envelope itself.
    let notification = rawPayload
    if (typeof rawPayload.Message === 'string' && rawPayload.Message.trim()) {
      try {
        notification = JSON.parse(rawPayload.Message)
      } catch {
        // Genuine delivery with an unparseable payload: authenticated but not
        // processable. Null → the controller answers 400, nothing is mutated.
        return null
      }
    }

    return mapSesNotification(notification)
  }

  private rejectWebhook(reason: SnsRejectionReason): void {
    logger.warn(`[SesMailProvider] Rejected webhook: ${reason}`)
    mailWebhookRejectionsTotal.inc({ reason })
  }
}

/**
 * Translate a verified SES notification (the object inside the SNS `Message`
 * field) into the registry event shape. `notificationType` and `mail` are the
 * canonical SES NotificationConfiguration fields.
 */
function mapSesNotification(notification: any): MailWebhookEvent | null {
  if (
    !notification ||
    typeof notification !== 'object' ||
    !notification.notificationType
  ) {
    return null
  }

  const notificationType = (notification.notificationType || '').toLowerCase()
  const type =
    notificationType === 'bounce'
      ? 'bounce'
      : notificationType === 'complaint'
        ? 'complaint'
        : 'delivery'
  const mail = notification.mail || {}
  const recipient = mail.destination?.[0] || 'unknown@example.com'
  return {
    type,
    messageId: mail.messageId || 'msg_ses_unknown',
    recipient,
    reason:
      notification.bounce?.bounceType ||
      notification.complaint?.complaintFeedbackType,
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

  /**
   * Route a mail webhook to the providers in priority order.
   *
   * A primary that *rejects the payload as unauthenticated* propagates the
   * rejection (the controller turns it into 401) instead of falling through to
   * the fallback: a forged SES payload must never be rescued into processing
   * by a provider that trusts its shape (#524). A primary that returns null —
   * "not my format" without an identity question — lets the fallback try.
   */
  async parseWebhook(
    rawPayload: any,
    signature?: string
  ): Promise<MailWebhookEvent | null> {
    try {
      const primary = await this.primaryProvider.parseWebhook(
        rawPayload,
        signature
      )
      if (primary) return primary
    } catch (err) {
      if (err instanceof SesSignatureVerificationError) throw err
      // A provider error that is not an authentication failure must not fail
      // the whole path on a delivery the fallback might understand.
      logger.warn('[MailRegistry] Mail webhook error on primary provider', {
        provider: this.primaryProvider.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return (
      (await this.fallbackProvider.parseWebhook(rawPayload, signature)) ?? null
    )
  }
}

export const mailRegistry = new MailRegistry()
