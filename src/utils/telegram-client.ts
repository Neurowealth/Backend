import { config } from '../config'
import { HttpClientAdapter, CircuitBreakerError, TimeoutError } from './http-client'
import { logger } from './logger'

export interface SendTelegramMessageParams {
  chatId: number | string
  text: string
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2'
}

export interface TelegramSendResult {
  messageId: string
  ok: boolean
}

export class TelegramApiError extends Error {
  public statusCode?: number
  public errorCode?: number
  public retryAfterSeconds?: number
  public isTransient: boolean

  constructor(
    message: string,
    options?: {
      statusCode?: number
      errorCode?: number
      retryAfterSeconds?: number
      isTransient?: boolean
    }
  ) {
    super(message)
    this.name = 'TelegramApiError'
    this.statusCode = options?.statusCode
    this.errorCode = options?.errorCode
    this.retryAfterSeconds = options?.retryAfterSeconds
    this.isTransient = options?.isTransient ?? false
  }
}

const httpClient = new HttpClientAdapter({
  timeoutMs: config.httpClient.timeoutMs,
  maxRetries: config.httpClient.maxRetries,
  baseDelayMs: config.httpClient.baseDelayMs,
  maxDelayMs: config.httpClient.maxDelayMs,
  circuitBreakerThreshold: config.httpClient.circuitBreakerThreshold,
  circuitBreakerResetMs: config.httpClient.circuitBreakerResetMs,
})

/**
 * Classify whether an error from Telegram is transient and safe to retry.
 */
export function isTelegramTransientError(error: unknown): boolean {
  if (error instanceof TelegramApiError) {
    return error.isTransient
  }
  if (error instanceof TimeoutError || error instanceof CircuitBreakerError) {
    return true
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('network') ||
      msg.includes('fetch failed') ||
      msg.includes('bad gateway') ||
      msg.includes('service unavailable') ||
      msg.includes('gateway timeout')
    ) {
      return true
    }
  }
  return false
}

/**
 * Extract retry-after in seconds if returned by Telegram (HTTP 429).
 */
export function extractTelegramRetryAfter(error: unknown): number | undefined {
  if (error instanceof TelegramApiError) {
    return error.retryAfterSeconds
  }
  return undefined
}

/**
 * Sends a message via the Telegram Bot API with circuit breaker, timeout, and transient retry.
 */
export async function sendTelegramMessage(
  params: SendTelegramMessageParams
): Promise<TelegramSendResult> {
  const token = config.telegram.botToken
  if (!token) {
    throw new TelegramApiError('TELEGRAM_BOT_TOKEN is not configured', {
      isTransient: false,
    })
  }

  const apiUrl = config.telegram.apiUrl || 'https://api.telegram.org'
  const endpoint = `${apiUrl}/bot${token}/sendMessage`

  return httpClient.execute(async () => {
    const payload = {
      chat_id:
        typeof params.chatId === 'string' && /^\d+$/.test(params.chatId)
          ? Number(params.chatId)
          : params.chatId,
      text: params.text,
      parse_mode: params.parseMode ?? 'HTML',
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    let data: any = null
    try {
      data = await response.json()
    } catch {
      // response body was not valid JSON
    }

    if (!response.ok || !data?.ok) {
      const statusCode = response.status
      const errorCode = data?.error_code || statusCode
      const description =
        data?.description || `Telegram Bot API error HTTP ${statusCode}`
      const retryAfter =
        data?.parameters?.retry_after ??
        (response.headers.get('retry-after')
          ? parseInt(response.headers.get('retry-after')!, 10)
          : undefined)

      // 429 and 5xx are transient; 400/403/404 are permanent
      const isTransient =
        statusCode === 429 ||
        statusCode >= 500 ||
        errorCode === 429 ||
        errorCode >= 500

      logger.warn('[Telegram] Send message failed', {
        chatId: params.chatId,
        statusCode,
        errorCode,
        description,
        isTransient,
        retryAfter,
      })

      throw new TelegramApiError(description, {
        statusCode,
        errorCode,
        retryAfterSeconds: retryAfter,
        isTransient,
      })
    }

    const messageId = String(data.result?.message_id ?? Date.now())
    logger.info(`[Telegram] Message sent to chat ${params.chatId}: id=${messageId}`)
    return {
      messageId,
      ok: true,
    }
  }, 'telegram.sendMessage')
}

export function resetTelegramClient(): void {
  httpClient.reset()
}

export function getTelegramHttpClient(): HttpClientAdapter {
  return httpClient
}
