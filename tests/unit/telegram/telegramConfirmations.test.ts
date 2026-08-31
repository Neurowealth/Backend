// Telegram financial-command confirmation + alert-rule management (#402).
// Telegram has no voice channel, so — unlike WhatsApp, where only
// voice-originated financial intents are gated — EVERY deposit/withdraw over
// Telegram parks a confirmation first. The security-critical assertion is that
// a financial intent never executes on the first pass.
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
// Force the regex fast-path only, so no live Claude call is attempted.
process.env.AI_MODE = 'local'

import { handleTelegramMessage } from '../../../src/telegram/handler'
import {
  clearTelegramUsersForTests,
  getTelegramUser,
} from '../../../src/telegram/userManager'
import {
  clearAllPendingConfirmations,
  setPendingConfirmation,
  getPendingConfirmation,
  clearPendingConfirmation,
} from '../../../src/telegram/pendingConfirmations'
import {
  createAlertRuleForWallet,
  listAlertRulesForWallet,
  deleteAlertRuleForWallet,
} from '../../../src/telegram/alertManager'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Stub the custodial-wallet creation the chat store triggers, so tests don't
// touch Stellar/crypto.
jest.mock('../../../src/stellar/wallet', () => ({
  createCustodialWallet: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
  getWalletByUserId: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
}))

// The alert manager is mocked so the handler's alert wiring can be tested in
// isolation from Prisma (the real manager is covered by the same DB-owner-scope
// pattern as src/whatsapp/alertManager.ts).
jest.mock('../../../src/telegram/alertManager', () => ({
  createAlertRuleForWallet: jest.fn(),
  listAlertRulesForWallet: jest.fn(),
  deleteAlertRuleForWallet: jest.fn(),
}))

const mockCreateAlert = createAlertRuleForWallet as jest.Mock
const mockListAlerts = listAlertRulesForWallet as jest.Mock
const mockDeleteAlert = deleteAlertRuleForWallet as jest.Mock

const CHAT = 7

/** Link a chat (via the one-time code flow) and give it a starting balance. */
async function linkedAndFundedChat(
  chatId: number | string,
  balance = 1000
): Promise<string> {
  const chat = String(chatId)
  const linkReply = await handleTelegramMessage(chat, 'hello')
  const codeMatch = linkReply.match(/code:\s*([A-Z0-9-]+)/i)
  expect(codeMatch).not.toBeNull()
  const reply = await handleTelegramMessage(chat, `link ${codeMatch?.[1]}`)
  expect(reply).toContain('linked')

  const user = getTelegramUser(chat)!
  // Directly set the balance via the test view.
  ;(user as { balance: number }).balance = balance
  return chat
}

beforeEach(() => {
  jest.clearAllMocks()
  clearTelegramUsersForTests()
  clearAllPendingConfirmations()
})

describe('Telegram financial confirmation (#402)', () => {
  it('does NOT execute a Telegram withdrawal on the first pass — asks to confirm', async () => {
    await linkedAndFundedChat(CHAT, 500)

    const res = await handleTelegramMessage(CHAT, 'withdraw 50')

    // Confirmation prompt, NOT a withdrawal confirmation.
    expect(res).toMatch(/confirm/i)
    expect(res).toMatch(/withdraw 50/i)
    // Balance untouched — nothing executed.
    expect(getTelegramUser(String(CHAT))!.balance).toBe(500)
  })

  it('executes the withdrawal only after an affirmative reply', async () => {
    await linkedAndFundedChat(CHAT, 500)

    await handleTelegramMessage(CHAT, 'withdraw 50') // parks confirmation
    const res = await handleTelegramMessage(CHAT, 'yes')

    expect(res).toMatch(/withdrawal request received/i)
    expect(getTelegramUser(String(CHAT))!.balance).toBe(450)
  })

  it('cancels the pending action on a negative reply without executing', async () => {
    await linkedAndFundedChat(CHAT, 500)

    await handleTelegramMessage(CHAT, 'withdraw 50')
    const res = await handleTelegramMessage(CHAT, 'no')

    expect(res).toMatch(/cancel/i)
    expect(getTelegramUser(String(CHAT))!.balance).toBe(500)
  })

  it('keeps the pending action when the reply is unrelated, instead of bypassing it', async () => {
    await linkedAndFundedChat(CHAT, 500)

    await handleTelegramMessage(CHAT, 'withdraw 50')
    const res = await handleTelegramMessage(CHAT, 'balance')

    // Re-prompt, not a balance reply — the pending action is still live.
    expect(res).toMatch(/pending action/i)
    expect(getTelegramUser(String(CHAT))!.balance).toBe(500)

    const confirmed = await handleTelegramMessage(CHAT, 'yes')
    expect(confirmed).toMatch(/withdrawal request received/i)
    expect(getTelegramUser(String(CHAT))!.balance).toBe(450)
  })

  it('does not require confirmation for a read-only balance command', async () => {
    await linkedAndFundedChat(CHAT, 500)

    const res = await handleTelegramMessage(CHAT, 'balance')

    expect(res).toMatch(/Your current balance/i)
    expect(getTelegramUser(String(CHAT))!.balance).toBe(500)
  })

  it('confirms "withdraw all" before emptying the balance', async () => {
    await linkedAndFundedChat(CHAT, 500)

    const parked = await handleTelegramMessage(CHAT, 'withdraw all')
    expect(parked).toMatch(/withdraw all/i)
    expect(parked).toMatch(/confirm/i)
    expect(getTelegramUser(String(CHAT))!.balance).toBe(500)

    const res = await handleTelegramMessage(CHAT, 'yes')
    expect(res).toMatch(/withdrawal request received/i)
    expect(getTelegramUser(String(CHAT))!.balance).toBe(0)
  })

  it('confirms a deposit command before showing deposit instructions', async () => {
    await linkedAndFundedChat(CHAT)

    const parked = await handleTelegramMessage(CHAT, 'deposit 10')
    expect(parked).toMatch(/confirm/i)
    expect(parked).toMatch(/deposit 10/i)

    const res = await handleTelegramMessage(CHAT, 'yes')
    expect(res).toMatch(/To deposit/i)
  })

  it('still answers read-only intents like help directly, without confirmation', async () => {
    await linkedAndFundedChat(CHAT)

    const res = await handleTelegramMessage(CHAT, 'help')

    expect(res).toMatch(/Welcome to NeuroWealth/i)
  })
})

describe('Telegram pending-confirmation store (#402)', () => {
  const now = 1_700_000_000_000
  const withdrawIntent = {
    action: 'withdraw' as const,
    confidence: 1,
    amount: 5,
  }

  it('returns the pending confirmation within the TTL', () => {
    setPendingConfirmation('1', withdrawIntent, 'withdraw 5', now)
    expect(getPendingConfirmation('1', now + 60_000)?.summary).toBe(
      'withdraw 5'
    )
  })

  it('evicts a confirmation once the TTL has elapsed', () => {
    setPendingConfirmation('1', withdrawIntent, 'withdraw 5', now)
    expect(getPendingConfirmation('1', now + 5 * 60_000 + 1)).toBeNull()
  })

  it('clears a stored confirmation', () => {
    setPendingConfirmation('1', withdrawIntent, 'withdraw 5', now)
    clearPendingConfirmation('1')
    expect(getPendingConfirmation('1', now)).toBeNull()
  })
})

describe('Telegram alert rules (#402)', () => {
  it('creates an alert rule from a conversational command', async () => {
    await linkedAndFundedChat(CHAT)
    mockCreateAlert.mockResolvedValue({
      ok: true,
      rule: {
        id: 'alert-1',
        metric: 'PROTOCOL_APY',
        protocolName: 'Blend',
        comparator: 'LT',
        threshold: 5,
        deliveryChannel: 'WEBHOOK',
        cooldownMinutes: 60,
        isActive: true,
      },
    })

    const res = await handleTelegramMessage(CHAT, 'alert me when Blend apy < 5')

    expect(res).toMatch(/Alert created/i)
    expect(mockCreateAlert).toHaveBeenCalledWith(
      getTelegramUser(String(CHAT))!.walletAddress,
      expect.objectContaining({
        metric: 'apy',
        protocolName: 'blend',
        comparator: '<',
        threshold: 5,
        deliveryChannel: 'WEBHOOK',
      })
    )
  })

  it('lists a user\u2019s alert rules', async () => {
    await linkedAndFundedChat(CHAT)
    mockListAlerts.mockResolvedValue([
      {
        id: 'a1',
        metric: 'PROTOCOL_APY',
        protocolName: 'Blend',
        comparator: 'LT',
        threshold: 5,
        deliveryChannel: 'WEBHOOK',
        cooldownMinutes: 60,
        isActive: true,
      },
    ])

    const res = await handleTelegramMessage(CHAT, 'list my alerts')

    expect(res).toMatch(/Your alert rules/i)
    expect(res).toMatch(/Blend/i)
  })

  it('deletes an alert rule by id', async () => {
    await linkedAndFundedChat(CHAT)
    mockDeleteAlert.mockResolvedValue(true)

    const res = await handleTelegramMessage(CHAT, 'delete alert a1')

    expect(res).toMatch(/Alert deleted/i)
    expect(mockDeleteAlert).toHaveBeenCalledWith(
      getTelegramUser(String(CHAT))!.walletAddress,
      'a1'
    )
  })
})
