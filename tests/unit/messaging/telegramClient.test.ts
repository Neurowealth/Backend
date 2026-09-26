process.env.NODE_ENV = 'test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token-123'
process.env.TELEGRAM_API_URL = 'https://api.telegram.org'

import {
  sendTelegramMessage,
  isTelegramTransientError,
  extractTelegramRetryAfter,
  TelegramApiError,
  resetTelegramClient,
} from '../../../src/utils/telegram-client'
import { TimeoutError, CircuitBreakerError } from '../../../src/utils/http-client'

describe('Telegram Client (#493)', () => {
  beforeEach(() => {
    resetTelegramClient()
    jest.restoreAllMocks()
  })

  it('successfully delivers message to Telegram Bot API', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 998877 },
      }),
    } as Response)

    const result = await sendTelegramMessage({
      chatId: 123456,
      text: '<b>Hello</b> World',
      parseMode: 'HTML',
    })

    expect(result.ok).toBe(true)
    expect(result.messageId).toBe('998877')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token-123/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: 123456,
          text: '<b>Hello</b> World',
          parse_mode: 'HTML',
        }),
      })
    )
  })

  it('handles rate limit 429 and extracts retry_after', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '12' }),
      json: async () => ({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 12',
        parameters: { retry_after: 12 },
      }),
    } as Response)

    await expect(
      sendTelegramMessage({
        chatId: '123456',
        text: 'Test',
      })
    ).rejects.toThrow('Too Many Requests')

    const err = new TelegramApiError('Too Many Requests', {
      statusCode: 429,
      retryAfterSeconds: 12,
      isTransient: true,
    })

    expect(isTelegramTransientError(err)).toBe(true)
    expect(extractTelegramRetryAfter(err)).toBe(12)
  })

  it('identifies 5xx server errors as transient', async () => {
    const err502 = new TelegramApiError('Bad Gateway', {
      statusCode: 502,
      isTransient: true,
    })
    expect(isTelegramTransientError(err502)).toBe(true)

    const timeoutErr = new TimeoutError(5000, 'telegram.sendMessage')
    expect(isTelegramTransientError(timeoutErr)).toBe(true)

    const cbErr = new CircuitBreakerError('telegram.sendMessage')
    expect(isTelegramTransientError(cbErr)).toBe(true)
  })

  it('identifies 400 and 403 as permanent non-transient errors', () => {
    const err400 = new TelegramApiError('Bad Request: chat not found', {
      statusCode: 400,
      isTransient: false,
    })
    expect(isTelegramTransientError(err400)).toBe(false)

    const err403 = new TelegramApiError('Forbidden: bot was blocked by the user', {
      statusCode: 403,
      isTransient: false,
    })
    expect(isTelegramTransientError(err403)).toBe(false)
  })
})
