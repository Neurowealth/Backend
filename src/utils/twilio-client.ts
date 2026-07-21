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
