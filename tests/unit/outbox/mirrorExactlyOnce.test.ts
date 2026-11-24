/**
 * src/outbox/service.ts — the side effects behind a confirmed or failed op
 * (#822, #824). A protection fund payout debits the fund exactly once per
 * claim, and a failure never overwrites a Transaction that already settled.
 */

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/db', () => {
  const tx = {
    coverageClaim: { updateMany: jest.fn() },
    protectionFundBalance: { updateMany: jest.fn() },
  }
  const client: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    outboxOp: { updateMany: jest.fn() },
    transaction: { updateMany: jest.fn() },
    __tx: tx,
  }
  return { __esModule: true, default: client }
})

import db from '../../../src/db'
import {
  markConfirmed,
  mirrorLinkedTransaction,
} from '../../../src/outbox/service'

const client = db as any
const tx = client.__tx

const payout = {
  method: 'protection_fund_payout' as const,
  userId: 'u1',
  userAddress: 'GUSER',
  amount: 250,
  assetSymbol: 'USDC',
  claimId: 'claim-1',
  eventId: 'event-1',
}

beforeEach(() => jest.clearAllMocks())

describe('markConfirmed', () => {
  it('reports true only when it moved the op to CONFIRMED', async () => {
    client.outboxOp.updateMany.mockResolvedValueOnce({ count: 1 })
    await expect(markConfirmed('op-1', 'h')).resolves.toBe(true)

    client.outboxOp.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(markConfirmed('op-1', 'h')).resolves.toBe(false)
  })
})

describe('protection fund payout mirroring (#824)', () => {
  it('marks the claim PAID and debits the fund on the first confirmation', async () => {
    tx.coverageClaim.updateMany.mockResolvedValue({ count: 1 })

    await mirrorLinkedTransaction(payout, { txHash: 'h', status: 'CONFIRMED' })

    expect(tx.coverageClaim.updateMany).toHaveBeenCalledWith({
      where: { id: 'claim-1', status: { not: 'PAID' } },
      data: { status: 'PAID' },
    })
    expect(tx.protectionFundBalance.updateMany).toHaveBeenCalledWith({
      where: { assetSymbol: 'USDC' },
      data: { amount: { decrement: 250 } },
    })
  })

  it('debits nothing when the claim is already PAID (replay or race)', async () => {
    tx.coverageClaim.updateMany.mockResolvedValue({ count: 0 })

    await mirrorLinkedTransaction(payout, { txHash: 'h', status: 'CONFIRMED' })

    expect(tx.protectionFundBalance.updateMany).not.toHaveBeenCalled()
  })

  it('debits exactly once across repeated confirmations', async () => {
    tx.coverageClaim.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 })

    await mirrorLinkedTransaction(payout, { txHash: 'h', status: 'CONFIRMED' })
    await mirrorLinkedTransaction(payout, { txHash: 'h', status: 'CONFIRMED' })
    await mirrorLinkedTransaction(payout, { txHash: 'h', status: 'CONFIRMED' })

    expect(tx.protectionFundBalance.updateMany).toHaveBeenCalledTimes(1)
  })

  it('leaves the claim and fund alone on failure', async () => {
    await mirrorLinkedTransaction(payout, { status: 'FAILED' })

    expect(tx.coverageClaim.updateMany).not.toHaveBeenCalled()
    expect(tx.protectionFundBalance.updateMany).not.toHaveBeenCalled()
  })
})

describe('linked Transaction mirroring (#822)', () => {
  const withdraw = {
    method: 'withdraw' as const,
    userId: 'u1',
    userAddress: 'GUSER',
    amount: 10,
    assetSymbol: 'USDC',
    transactionId: 'tx-1',
  }

  it('marks the row FAILED but never overwrites a CONFIRMED one', async () => {
    await mirrorLinkedTransaction(withdraw, { status: 'FAILED' })

    expect(client.transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', status: { not: 'CONFIRMED' } },
      data: { txHash: undefined, status: 'FAILED', confirmedAt: null },
    })
  })

  it('confirms the row unconditionally', async () => {
    await mirrorLinkedTransaction(withdraw, {
      txHash: 'h',
      status: 'CONFIRMED',
    })

    const call = client.transaction.updateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'tx-1' })
    expect(call.data).toMatchObject({ txHash: 'h', status: 'CONFIRMED' })
  })
})
