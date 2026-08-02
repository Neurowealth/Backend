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
process.env.TELEGRAM_BOT_TOKEN = '123:test-token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret'
process.env.AI_MODE = 'local'

import express from 'express'
import request from 'supertest'

import telegramRouter from '../../../src/routes/telegram'
import { clearTelegramUsersForTests } from '../../../src/telegram/userManager'
import { handleTelegramMessage } from '../../../src/telegram/handler'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/stellar/wallet', () => ({
  createCustodialWallet: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
  getWalletByUserId: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
}))

describe('Telegram webhook', () => {
  beforeEach(() => {
    clearTelegramUsersForTests()
    jest.restoreAllMocks()
  })

  it('rejects requests with a missing or invalid secret token', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/telegram', telegramRouter)

    const missingSecret = await request(app)
      .post('/api/telegram')
      .send({ message: { chat: { id: 42 }, text: 'hello' } })

    expect(missingSecret.status).toBe(401)

    const badSecret = await request(app)
      .post('/api/telegram')
      .set('x-telegram-bot-api-secret-token', 'wrong-secret')
      .send({ message: { chat: { id: 42 }, text: 'hello' } })

    expect(badSecret.status).toBe(401)
  })

  it('replies via the Telegram Bot API for an unlinked chat', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response)

    const app = express()
    app.use(express.json())
    app.use('/api/telegram', telegramRouter)

    const response = await request(app)
      .post('/api/telegram')
      .set('x-telegram-bot-api-secret-token', 'test-secret')
      .send({ message: { chat: { id: 42 }, text: 'hello' } })

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    )
    const [, options] = fetchSpy.mock.calls[0]
    const payload = JSON.parse((options as RequestInit).body as string)
    expect(payload.text).toContain('link code')
  })

  it('links a Telegram chat to a WhatsApp user via a one-time code', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response)

    const app = express()
    app.use(express.json())
    app.use('/api/telegram', telegramRouter)

    const first = await request(app)
      .post('/api/telegram')
      .set('x-telegram-bot-api-secret-token', 'test-secret')
      .send({ message: { chat: { id: 99 }, text: 'hello' } })

    expect(first.status).toBe(200)
    const [, options] = fetchSpy.mock.calls[0]
    const payload = JSON.parse((options as RequestInit).body as string)
    const codeMatch = payload.text.match(/code:\s*([A-Z0-9-]+)/i)
    expect(codeMatch).not.toBeNull()
    const code = codeMatch?.[1]

    const linked = await handleTelegramMessage(99, 'balance')
    expect(linked).toContain('not linked')

    const whatsappUser = await handleTelegramMessage(99, `link ${code}`)
    expect(whatsappUser).toContain('linked')

    const linkedReply = await handleTelegramMessage(99, 'balance')
    expect(linkedReply).toContain('Your current balance')
  })
})
