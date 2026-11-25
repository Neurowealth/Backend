// WhatsApp financial-command confirmation gate for typed and LLM-parsed
// intents. Mirrors Telegram's confirmation flow so a mistyped or
// LLM-misclassified command can never move funds in a single step.
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
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32)
process.env.AI_MODE = 'claude'

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }))
})

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockExecuteBotWithdrawal = jest.fn()
jest.mock('../../../src/botWithdrawals', () => ({
  executeBotWithdrawal: (...args: unknown[]) =>
    mockExecuteBotWithdrawal(...args),
}))

jest.mock('../../../src/agent/assistant/assistant', () => ({
  handleAssistantMessage: jest.fn(),
}))

const mockUserFindFirst = jest.fn()
const mockRecurringPlanCreate = jest.fn()
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findFirst: (...args: unknown[]) => mockUserFindFirst(...args),
    },
    recurringDepositPlan: {
      create: (...args: unknown[]) => mockRecurringPlanCreate(...args),
    },
  },
}))

jest.mock('../../../src/stellar/wallet', () => ({
  createCustodialWallet: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
  getWalletByUserId: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
}))

import { handleWhatsAppMessage } from '../../../src/whatsapp/handler'
import {
  getUserForTests,
  clearUsersForTests,
} from '../../../src/whatsapp/userManager'
import { clearAllPendingConfirmations } from '../../../src/whatsapp/pendingConfirmations'

const PHONE = 'whatsapp:+15551234567'

async function verifiedUser(phone: string, balance = 1000): Promise<void> {
  await handleWhatsAppMessage(phone, 'hello')
  const user = getUserForTests(phone)!
  ;(user as { verified: boolean; balance: number }).verified = true
  ;(user as { verified: boolean; balance: number }).balance = balance
}

beforeEach(() => {
  jest.clearAllMocks()
  mockExecuteBotWithdrawal.mockResolvedValue({
    ok: true,
    body: 'Withdrawal submitted for 50.00 XLM.\nTransaction reference: tx-hash',
    reference: 'tx-hash',
  })
  mockUserFindFirst.mockResolvedValue({ id: 'user-1' })
  mockRecurringPlanCreate.mockResolvedValue({ id: 'plan-1' })
  clearUsersForTests()
  clearAllPendingConfirmations()
})

describe('WhatsApp typed & LLM financial confirmations', () => {
  it('gates typed "withdraw 50" behind yes/no confirmation before calling executeBotWithdrawal', async () => {
    await verifiedUser(PHONE, 500)

    const prompt = await handleWhatsAppMessage(PHONE, 'withdraw 50')

    expect(mockExecuteBotWithdrawal).not.toHaveBeenCalled()
    expect(prompt.body).toMatch(/confirm/i)
    expect(prompt.body).toMatch(/withdraw 50/i)
    expect(prompt.body).toMatch(/yes/i)
    expect(prompt.body).toMatch(/no/i)

    const confirmed = await handleWhatsAppMessage(PHONE, 'yes')

    expect(mockExecuteBotWithdrawal).toHaveBeenCalledTimes(1)
    expect(mockExecuteBotWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', amount: 50 })
    )
    expect(confirmed.body).toContain('tx-hash')
  })

  it('cancels a typed withdrawal when the user replies "no"', async () => {
    await verifiedUser(PHONE, 500)

    await handleWhatsAppMessage(PHONE, 'withdraw 50')
    const cancelled = await handleWhatsAppMessage(PHONE, 'no')

    expect(mockExecuteBotWithdrawal).not.toHaveBeenCalled()
    expect(cancelled.body).toMatch(/cancel/i)
  })

  it('keeps the pending withdrawal on an unrelated message and executes only on "yes"', async () => {
    await verifiedUser(PHONE, 500)

    await handleWhatsAppMessage(PHONE, 'withdraw 50')
    const reprompt = await handleWhatsAppMessage(PHONE, 'balance')

    expect(mockExecuteBotWithdrawal).not.toHaveBeenCalled()
    expect(reprompt.body).toMatch(/pending action/i)

    await handleWhatsAppMessage(PHONE, 'yes')
    expect(mockExecuteBotWithdrawal).toHaveBeenCalledTimes(1)
  })

  it('gates typed deposit intents behind confirmation before showing deposit instructions', async () => {
    await verifiedUser(PHONE)

    const prompt = await handleWhatsAppMessage(PHONE, 'deposit 10')

    expect(prompt.body).toMatch(/confirm/i)
    expect(prompt.body).toMatch(/deposit 10/i)
    expect(prompt.body).not.toMatch(/To deposit/i)

    const confirmed = await handleWhatsAppMessage(PHONE, 'yes')
    expect(confirmed.body).toMatch(/To deposit/i)
  })

  it('gates LLM-parsed withdraw intents behind confirmation before calling executeBotWithdrawal', async () => {
    await verifiedUser(PHONE, 500)
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ action: 'withdraw', amount: 50 }),
        },
      ],
    })

    const prompt = await handleWhatsAppMessage(
      PHONE,
      'could you please take fifty out for me'
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockExecuteBotWithdrawal).not.toHaveBeenCalled()
    expect(prompt.body).toMatch(/confirm/i)
    expect(prompt.body).toMatch(/yes/i)
    expect(prompt.body).toMatch(/no/i)

    await handleWhatsAppMessage(PHONE, 'yes')
    expect(mockExecuteBotWithdrawal).toHaveBeenCalledTimes(1)
    expect(mockExecuteBotWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', amount: 50 })
    )
  })

  it('gates LLM-parsed create_recurring_deposit intents behind confirmation showing amount, asset, and cadence', async () => {
    await verifiedUser(PHONE, 500)
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'create_recurring_deposit',
            amount: 50,
            cadence: 'WEEKLY',
          }),
        },
      ],
    })

    const prompt = await handleWhatsAppMessage(
      PHONE,
      'automatically put in fifty dollars every seven days'
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockRecurringPlanCreate).not.toHaveBeenCalled()
    expect(prompt.body).toMatch(/confirm/i)
    expect(prompt.body).toMatch(/50/)
    expect(prompt.body).toMatch(/USDC/i)
    expect(prompt.body).toMatch(/weekly/i)

    const confirmed = await handleWhatsAppMessage(PHONE, 'yes')
    expect(mockRecurringPlanCreate).toHaveBeenCalledTimes(1)
    expect(confirmed.body).toMatch(/Recurring deposit created/i)
  })
})
