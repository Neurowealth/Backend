// Approval-gate wiring in the money path (#314). Pins that guardOperation is
// consulted from INSIDE executeDeposit/executeWithdraw — the single
// interception point the HTTP routes and src/jobs/recurringDeposits.ts all
// share — and that a denied guard short-circuits before any on-chain
// submission or Transaction row is created. skipApprovalGuard (set only by
// src/approvals/executors.ts on the post-approval re-run) bypasses the gate.
process.env.NODE_ENV = 'test'

import db from '../../../src/db'
import { guardOperation } from '../../../src/approvals/service'
import { enqueueOutboxOp } from '../../../src/outbox/service'
import { dispatchOne } from '../../../src/outbox/dispatcher'
import {
  executeDeposit,
  executeWithdraw,
} from '../../../src/controllers/transaction-controller'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    transaction: { create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('../../../src/approvals/service', () => ({
  guardOperation: jest.fn(),
}))
jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: jest.fn(),
}))
jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchOne: jest.fn(),
}))
jest.mock('../../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

const mockDb = db as any
const mockGuard = guardOperation as jest.Mock
const mockEnqueue = enqueueOutboxOp as jest.Mock
const mockDispatchOne = dispatchOne as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.user.findUnique.mockResolvedValue({ id: 'user-1', network: 'MAINNET' })
})

describe('executeDeposit — approval gate', () => {
  it('returns PENDING_APPROVAL and submits nothing when the guard denies', async () => {
    mockGuard.mockResolvedValue({
      allowed: false,
      requestId: 'req-1',
      expiresAt: new Date(),
    })

    const result = await executeDeposit({
      userId: 'user-1',
      walletAddress: 'G...WALLET',
      amount: 5000,
      assetSymbol: 'USDC',
    })

    expect(result).toEqual({
      transaction: null,
      status: 'PENDING_APPROVAL',
      approvalRequestId: 'req-1',
    })
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockDispatchOne).not.toHaveBeenCalled()
  })

  it('proceeds to submission when the guard allows', async () => {
    mockGuard.mockResolvedValue({ allowed: true })
    mockDb.$transaction.mockImplementation(async (fn: any) =>
      fn({
        transaction: {
          create: jest
            .fn()
            .mockResolvedValue({ id: 'tx-1', txHash: null, status: 'PENDING' }),
        },
      })
    )
    mockEnqueue.mockResolvedValue({ id: 'op-1' })
    mockDispatchOne.mockResolvedValue({ status: 'success', hash: '0xabc' })
    mockDb.transaction.update.mockResolvedValue({
      id: 'tx-1',
      txHash: '0xabc',
      status: 'CONFIRMED',
    })

    const result = await executeDeposit({
      userId: 'user-1',
      walletAddress: 'G...WALLET',
      amount: 5000,
      assetSymbol: 'USDC',
    })

    expect(result.status).toBe('CONFIRMED')
    expect(mockEnqueue).toHaveBeenCalled()
  })

  it('never calls the guard when skipApprovalGuard is set (post-approval re-run)', async () => {
    mockDb.$transaction.mockImplementation(async (fn: any) =>
      fn({
        transaction: {
          create: jest
            .fn()
            .mockResolvedValue({ id: 'tx-2', txHash: null, status: 'PENDING' }),
        },
      })
    )
    mockEnqueue.mockResolvedValue({ id: 'op-2' })
    mockDispatchOne.mockResolvedValue({ status: 'success', hash: '0xdef' })
    mockDb.transaction.update.mockResolvedValue({
      id: 'tx-2',
      txHash: '0xdef',
      status: 'CONFIRMED',
    })

    await executeDeposit({
      userId: 'user-1',
      walletAddress: 'G...WALLET',
      amount: 5000,
      assetSymbol: 'USDC',
      skipApprovalGuard: true,
    })

    expect(mockGuard).not.toHaveBeenCalled()
  })
})

describe('executeWithdraw — approval gate', () => {
  it('returns PENDING_APPROVAL and submits nothing when the guard denies', async () => {
    mockGuard.mockResolvedValue({
      allowed: false,
      requestId: 'req-2',
      expiresAt: new Date(),
    })

    const result = await executeWithdraw({
      userId: 'user-1',
      walletAddress: 'G...WALLET',
      amount: 5000,
      assetSymbol: 'USDC',
    })

    expect(result).toEqual({
      transaction: null,
      status: 'PENDING_APPROVAL',
      approvalRequestId: 'req-2',
    })
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('passes permission WITHDRAW to the guard', async () => {
    mockGuard.mockResolvedValue({
      allowed: false,
      requestId: 'req-3',
      expiresAt: new Date(),
    })

    await executeWithdraw({
      userId: 'user-1',
      walletAddress: 'G...WALLET',
      amount: 5000,
      assetSymbol: 'USDC',
    })

    expect(mockGuard).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'WITHDRAW' })
    )
  })
})
