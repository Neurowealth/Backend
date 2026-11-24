// #837 — bot withdrawals must go through the persisted withdrawal/outbox path.
// A fake "success" is never acceptable: only a real on-chain transaction
// reference may be reported as submitted, and every other path fails closed.

import db from '../../src/db'
import { executeWithdraw } from '../../src/controllers/transaction-controller'
import { executeBotWithdrawal } from '../../src/botWithdrawals'

jest.mock('../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../src/controllers/transaction-controller', () => ({
  executeWithdraw: jest.fn(),
}))

const mockDb = db as any
const mockExecuteWithdraw = executeWithdraw as jest.Mock

const DB_USER = { id: 'user-1', walletAddress: 'GDESTINATION' }

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.user = { findUnique: jest.fn().mockResolvedValue(DB_USER) }
  mockExecuteWithdraw.mockResolvedValue({
    status: 'CONFIRMED',
    transaction: { id: 'tx-1', txHash: 'onchain-hash' },
  })
})

describe('executeBotWithdrawal (#837)', () => {
  it('refuses a Telegram withdrawal: no persisted link identifies a DB account', async () => {
    const result = await executeBotWithdrawal({
      channel: 'telegram',
      identity: 'chat-1',
      amount: 5,
    })

    expect(result.ok).toBe(false)
    expect(result.reference).toBeNull()
    expect(result.body).toMatch(/temporarily unavailable/i)
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
  })

  it('refuses a WhatsApp sender with no DB user instead of reporting success', async () => {
    mockDb.user.findUnique.mockResolvedValue(null)

    const result = await executeBotWithdrawal({
      channel: 'whatsapp',
      identity: '+15550000000',
      amount: 5,
    })

    expect(result.ok).toBe(false)
    expect(result.body).toMatch(/temporarily unavailable/i)
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
  })

  it('routes a verified WhatsApp user through the real withdrawal service', async () => {
    const result = await executeBotWithdrawal({
      channel: 'whatsapp',
      identity: '+15550000000',
      amount: 12.5,
    })

    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { phone: '+15550000000' },
      select: { id: true, walletAddress: true },
    })
    expect(mockExecuteWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        walletAddress: 'GDESTINATION',
        amount: 12.5,
        assetSymbol: 'XLM',
      })
    )
    expect(result.ok).toBe(true)
    expect(result.reference).toBe('onchain-hash')
    expect(result.body).toContain('onchain-hash')
  })

  it('reports a durable PENDING op by reference without claiming submission', async () => {
    mockExecuteWithdraw.mockResolvedValue({
      status: 'PENDING',
      transaction: { id: 'tx-pending', txHash: null },
    })

    const result = await executeBotWithdrawal({
      channel: 'whatsapp',
      identity: '+15550000000',
      amount: 5,
    })

    expect(result.ok).toBe(false)
    expect(result.reference).toBe('tx-pending')
    expect(result.body).toMatch(/queued/i)
    expect(result.body).not.toMatch(/submitted|completed/i)
  })

  it('does not claim success while an approval is outstanding', async () => {
    mockExecuteWithdraw.mockResolvedValue({
      status: 'PENDING_APPROVAL',
      approvalRequestId: 'approval-1',
      transaction: null,
    })

    const result = await executeBotWithdrawal({
      channel: 'whatsapp',
      identity: '+15550000000',
      amount: 5,
    })

    expect(result.ok).toBe(false)
    expect(result.body).toMatch(/requires approval/i)
    expect(result.body).not.toMatch(/submitted|completed/i)
  })

  it('fails closed when the withdrawal service throws', async () => {
    mockExecuteWithdraw.mockRejectedValue(new Error('rpc down'))

    const result = await executeBotWithdrawal({
      channel: 'whatsapp',
      identity: '+15550000000',
      amount: 5,
    })

    expect(result.ok).toBe(false)
    expect(result.body).toMatch(/temporarily unavailable/i)
  })

  it('refuses "withdraw all" because the in-memory balance is not authoritative', async () => {
    const result = await executeBotWithdrawal({
      channel: 'whatsapp',
      identity: '+15550000000',
      amount: 0,
      all: true,
    })

    expect(result.ok).toBe(false)
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
  })

  it('rejects non-positive amounts before touching the withdrawal service', async () => {
    const result = await executeBotWithdrawal({
      channel: 'whatsapp',
      identity: '+15550000000',
      amount: -1,
    })

    expect(result.ok).toBe(false)
    expect(mockExecuteWithdraw).not.toHaveBeenCalled()
  })
})
