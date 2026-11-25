// End-to-end bot asset propagation tests (#926): exercises
// handleWhatsAppMessage -> executeBotWithdrawal -> mocked executeWithdraw so
// currency suffixes (e.g. USDC vs unsupported DOGE) are verified all the way
// to the withdrawal service.
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
process.env.AI_MODE = 'local'

const mockExecuteWithdraw = jest.fn()
jest.mock('../../../src/controllers/transaction-controller', () => ({
  executeWithdraw: (...args: unknown[]) => mockExecuteWithdraw(...args),
}))

const mockUserFindUnique = jest.fn()
const mockUserFindFirst = jest.fn()
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      findFirst: (...args: unknown[]) => mockUserFindFirst(...args),
    },
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/agent/assistant/assistant', () => ({
  handleAssistantMessage: jest.fn(),
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

async function verifiedUser(phone: string): Promise<void> {
  await handleWhatsAppMessage(phone, 'hello')
  const user = getUserForTests(phone)!
  ;(user as { verified: boolean; balance: number }).verified = true
  ;(user as { verified: boolean; balance: number }).balance = 500
}

beforeEach(() => {
  jest.clearAllMocks()
  clearUsersForTests()
  clearAllPendingConfirmations()
  mockUserFindUnique.mockResolvedValue({
    id: 'user-1',
    walletAddress: 'GDESTINATION',
  })
  mockUserFindFirst.mockResolvedValue({ id: 'user-1' })
  mockExecuteWithdraw.mockResolvedValue({
    status: 'CONFIRMED',
    transaction: { id: 'tx-1', txHash: 'onchain-usdc-hash' },
  })
})

describe('WhatsApp asset propagation and validation', () => {
  it('shows USDC in confirmation summary and calls executeWithdraw with assetSymbol: "USDC" after "yes"', async () => {
    await verifiedUser(PHONE)

    const prompt = await handleWhatsAppMessage(PHONE, 'withdraw 50 USDC')

    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
    expect(prompt.body).toMatch(/withdraw 50 USDC/i)
    expect(prompt.body).toMatch(/confirm/i)

    const res = await handleWhatsAppMessage(PHONE, 'yes')

    expect(mockExecuteWithdraw).toHaveBeenCalledTimes(1)
    expect(mockExecuteWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        walletAddress: 'GDESTINATION',
        amount: 50,
        assetSymbol: 'USDC',
      })
    )
    expect(res.body).toContain('50.00 USDC')
    expect(res.body).not.toContain('XLM')
  })

  it('rejects "withdraw 50 DOGE" explicitly without calling executeWithdraw', async () => {
    await verifiedUser(PHONE)

    const res = await handleWhatsAppMessage(PHONE, 'withdraw 50 DOGE')

    expect(res.body).toMatch(/unsupported asset/i)
    expect(res.body).toContain('DOGE')
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()

    // Even a subsequent "yes" must not trigger a withdrawal.
    await handleWhatsAppMessage(PHONE, 'yes')
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
  })

  it('includes the asset in deposit confirmation and instructions, and rejects unsupported deposit assets', async () => {
    await verifiedUser(PHONE)

    const prompt = await handleWhatsAppMessage(PHONE, 'deposit 25 USDC')
    expect(prompt.body).toMatch(/deposit 25 USDC/i)

    const confirmed = await handleWhatsAppMessage(PHONE, 'yes')
    expect(confirmed.body).toContain('25.00 USDC')

    const rejected = await handleWhatsAppMessage(PHONE, 'deposit 25 DOGE')
    expect(rejected.body).toMatch(/unsupported asset/i)
    expect(rejected.body).toContain('DOGE')
  })
})
