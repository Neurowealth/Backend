import twilio from 'twilio'
import { config } from '../config'
import { HttpClientAdapter } from './http-client'
import { logger } from './logger'

const httpClient = new HttpClientAdapter({
  timeoutMs: config.httpClient.timeoutMs,
  maxRetries: config.httpClient.maxRetries,
  baseDelayMs: config.httpClient.baseDelayMs,
  maxDelayMs: config.httpClient.maxDelayMs,
  circuitBreakerThreshold: config.httpClient.circuitBreakerThreshold,
  circuitBreakerResetMs: config.httpClient.circuitBreakerResetMs,
})

let twilioClient: ReturnType<typeof twilio> | null = null

function getClient(): ReturnType<typeof twilio> {
  if (!twilioClient) {
    const sid = config.whatsapp.twilioSid
    const token = config.whatsapp.twilioToken
    if (!sid || !token) {
      throw new Error(
        'Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)'
      )
    }
    twilioClient = twilio(sid, token)
  }
  return twilioClient
}

export interface SendMessageParams {
  to: string
  body: string
}

export async function sendWhatsAppMessage(
  params: SendMessageParams
): Promise<string> {
  return httpClient.execute(async () => {
    const client = getClient()
    const message = await client.messages.create({
      from: config.whatsapp.fromNumber,
      to: params.to,
      body: params.body,
    })
    logger.info(
      `[Twilio] WhatsApp message sent to ${params.to}: sid=${message.sid}`
    )
    return message.sid
  }, 'twilio.sendWhatsAppMessage')
}

export function resetTwilioClient(): void {
  twilioClient = null
}

export function getTwilioHttpClient(): HttpClientAdapter {
  return httpClient
}

/**
 * Classify whether an error from Twilio WhatsApp is transient.
 */
export function isWhatsAppTransientError(error: unknown): boolean {
  if (!error) return false
  const err = error as any
  const code = err.code || err.status
  if (code === 20429 || code === 429 || (typeof code === 'number' && code >= 500 && code < 600)) {
    return true
  }
  const msg = (err.message || '').toLowerCase()
  if (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('rate limit') ||
    msg.includes('circuit breaker is open')
  ) {
    return true
  }
  return false
}

export function extractWhatsAppRetryAfter(error: unknown): number | undefined {
  if (!error) return undefined
  const err = error as any
  if (err.retryAfter) return Number(err.retryAfter)
  return undefined
}

