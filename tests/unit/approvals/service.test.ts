// Approval workflow service unit tests (#314). Pin the high-risk invariants:
//   * zero-friction path is preserved when no policy applies / below threshold
//   * threshold-met creates a PENDING request and dispatches approval.requested
//   * repeated identical gated calls dedupe onto the same open request
//   * self-approval never counts toward minApprovers > 1
//   * only an eligible approver (policy owner + its ACTIVE children) may decide
//   * a race for the threshold-crossing decision executes exactly once
//   * cancellation is requester-only unless explicitly called as admin
import { Decimal } from '@prisma/client/runtime/library'
import db from '../../../src/db'
import { dispatchWebhookEvent } from '../../../src/services/webhookDispatcher'
import { runApprovedPayload } from '../../../src/approvals/executors'
import { guardOperation, decide, cancel } from '../../../src/approvals/service'
import { AppError } from '../../../src/utils/errors'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/approvals/executors', () => ({
  runApprovedPayload: jest.fn(),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client')
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      PrismaClientKnownRequestError: class extends Error {
        code: string
        constructor(msg: string, opts: { code: string }) {
          super(msg)
          this.code = opts.code
        }
      },
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Prisma } = require('@prisma/client')
function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002' })
}

const mockDb = db as any
const mockDispatch = dispatchWebhookEvent as jest.Mock
const mockRunApprovedPayload = runApprovedPayload as jest.Mock

const PARENT = 'parent-1'
const CHILD = 'child-1'

const basePolicy = {
  id: 'policy-1',
  principalUserId: PARENT,
  scopedToChildUserId: CHILD,
  permission: 'WITHDRAW',
  minApprovers: 2,
  highValueThreshold: new Decimal(1000),
  approvalTimeoutMs: 3_600_000,
  isActive: true,
}

const payload = {
  type: 'withdraw' as const,
  userId: CHILD,
  walletAddress: 'G...CHILD',
  amount: 5000,
  assetSymbol: 'USDC',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.approvalPolicy = { findFirst: jest.fn() }
  mockDb.approvalRequest = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  }
  mockDb.approval = {
    create: jest.fn(),
    count: jest.fn(),
  }
  mockDb.subAccount = { findMany: jest.fn().mockResolvedValue([]) }
})

describe('guardOperation', () => {
  it('allows the operation when no active policy exists', async () => {
    mockDb.approvalPolicy.findFirst.mockResolvedValue(null)

    const result = await guardOperation({
      userId: CHILD,
      actingAsUserId: PARENT,
      permission: 'WITHDRAW',
      amount: 5000,
      assetSymbol: 'USDC',
      payload,
    })

    expect(result).toEqual({ allowed: true })
    expect(mockDb.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('allows the operation when the amount is below highValueThreshold', async () => {
    mockDb.approvalPolicy.findFirst.mockResolvedValue(basePolicy)

    const result = await guardOperation({
      userId: CHILD,
      actingAsUserId: PARENT,
      permission: 'WITHDRAW',
      amount: 500,
      assetSymbol: 'USDC',
      payload,
    })

    expect(result).toEqual({ allowed: true })
  })

  it('gates and creates a PENDING request when the threshold is met, dispatching approval.requested', async () => {
    mockDb.approvalPolicy.findFirst.mockResolvedValue(basePolicy)
    mockDb.approvalRequest.findFirst.mockResolvedValue(null)
    mockDb.approvalRequest.create.mockResolvedValue({
      id: 'req-1',
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    const result = await guardOperation({
      userId: CHILD,
      actingAsUserId: PARENT,
      permission: 'WITHDRAW',
      amount: 5000,
      assetSymbol: 'USDC',
      payload,
    })

    expect(result).toEqual({
      allowed: false,
      requestId: 'req-1',
      expiresAt: expect.any(Date),
    })
    const createArg = mockDb.approvalRequest.create.mock.calls[0][0].data
    expect(createArg.minApprovers).toBe(2)
    expect(createArg.policyId).toBe('policy-1')
    expect(mockDispatch).toHaveBeenCalledWith(
      'approval.requested',
      expect.objectContaining({ requestId: 'req-1' })
    )
  })

  it('gates on a null threshold regardless of amount', async () => {
    mockDb.approvalPolicy.findFirst.mockResolvedValue({
      ...basePolicy,
      highValueThreshold: null,
    })
    mockDb.approvalRequest.findFirst.mockResolvedValue(null)
    mockDb.approvalRequest.create.mockResolvedValue({
      id: 'req-2',
      expiresAt: new Date(),
    })

    const result = await guardOperation({
      userId: CHILD,
      actingAsUserId: PARENT,
      permission: 'WITHDRAW',
      amount: 1,
      assetSymbol: 'USDC',
      payload,
    })

    expect(result.allowed).toBe(false)
  })

  it('dedupes onto an existing open request instead of creating a duplicate', async () => {
    mockDb.approvalPolicy.findFirst.mockResolvedValue(basePolicy)
    mockDb.approvalRequest.findFirst.mockResolvedValue({
      id: 'existing-req',
      expiresAt: new Date(Date.now() + 1_000_000),
    })

    const result = await guardOperation({
      userId: CHILD,
      actingAsUserId: PARENT,
      permission: 'WITHDRAW',
      amount: 5000,
      assetSymbol: 'USDC',
      payload,
    })

    expect(result).toEqual({
      allowed: false,
      requestId: 'existing-req',
      expiresAt: expect.any(Date),
    })
    expect(mockDb.approvalRequest.create).not.toHaveBeenCalled()
    expect(mockDispatch).not.toHaveBeenCalled()
  })
})

describe('decide', () => {
  const pendingRequest = {
    id: 'req-1',
    policyId: 'policy-1',
    userId: CHILD,
    actingAsUserId: PARENT,
    status: 'PENDING',
    minApprovers: 2,
    policy: basePolicy,
  }

  it('rejects a decision from someone outside the approver pool', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(pendingRequest)
    mockDb.subAccount.findMany.mockResolvedValue([]) // PARENT has no ACTIVE children besides CHILD... none returned here

    await expect(
      decide('req-1', 'stranger', true, undefined)
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects self-approval when minApprovers > 1', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(pendingRequest)
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])

    await expect(
      decide('req-1', PARENT, true, undefined)
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('requires a reason to reject', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(pendingRequest)
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])

    await expect(
      decide('req-1', CHILD, false, undefined)
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects with a reason via a conditional PENDING -> REJECTED update', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(pendingRequest)
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])
    mockDb.approval.create.mockResolvedValue({})
    mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 1 })

    const result = await decide('req-1', CHILD, false, 'looks wrong')

    expect(result.status).toBe('REJECTED')
    expect(mockDb.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'PENDING' },
      data: { status: 'REJECTED', reason: 'looks wrong' },
    })
    expect(mockDispatch).toHaveBeenCalledWith(
      'approval.rejected',
      expect.objectContaining({ requestId: 'req-1' })
    )
  })

  it('stays PENDING when approvals are below minApprovers', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(pendingRequest)
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])
    mockDb.approval.create.mockResolvedValue({})
    mockDb.approval.count.mockResolvedValue(1)

    const result = await decide('req-1', CHILD, true, undefined)

    expect(result).toEqual({ status: 'PENDING', approvalCount: 1 })
    expect(mockDb.approvalRequest.updateMany).not.toHaveBeenCalled()
    expect(mockRunApprovedPayload).not.toHaveBeenCalled()
  })

  it('executes exactly once when the threshold is crossed', async () => {
    mockDb.approvalRequest.findUnique
      .mockResolvedValueOnce(pendingRequest) // decide()'s initial load
      .mockResolvedValueOnce({ ...pendingRequest, payload }) // executeApprovedRequest's re-load
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])
    mockDb.approval.create.mockResolvedValue({})
    mockDb.approval.count.mockResolvedValue(2)
    mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 1 })
    mockDb.approvalRequest.update.mockResolvedValue({})
    mockRunApprovedPayload.mockResolvedValue({
      status: 'CONFIRMED',
      transaction: { id: 'tx-1', txHash: '0xabc' },
    })

    const result = await decide('req-1', CHILD, true, undefined)

    expect(result.status).toBe('EXECUTED')
    expect(mockRunApprovedPayload).toHaveBeenCalledTimes(1)
    expect(mockDb.approvalRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({
        status: 'EXECUTED',
        executedTxId: 'tx-1',
      }),
    })
    expect(mockDispatch).toHaveBeenCalledWith(
      'approval.executed',
      expect.objectContaining({ requestId: 'req-1', transactionId: 'tx-1' })
    )
  })

  it('does not execute twice when a concurrent decision already claimed the threshold', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(pendingRequest)
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])
    mockDb.approval.create.mockResolvedValue({})
    mockDb.approval.count.mockResolvedValue(2)
    // Another decide() call already won the conditional update.
    mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 0 })

    const result = await decide('req-1', CHILD, true, undefined)

    expect(result).toEqual({ status: 'PENDING', approvalCount: 2 })
    expect(mockRunApprovedPayload).not.toHaveBeenCalled()
  })

  it('leaves the request APPROVED (not EXECUTED) when execution fails', async () => {
    mockDb.approvalRequest.findUnique
      .mockResolvedValueOnce(pendingRequest)
      .mockResolvedValueOnce({ ...pendingRequest, payload })
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])
    mockDb.approval.create.mockResolvedValue({})
    mockDb.approval.count.mockResolvedValue(2)
    mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 1 })
    mockRunApprovedPayload.mockResolvedValue({
      status: 'FAILED',
      transaction: null,
    })

    const result = await decide('req-1', CHILD, true, undefined)

    expect(result).toEqual({ status: 'APPROVED', executionFailed: true })
    expect(mockDb.approvalRequest.update).not.toHaveBeenCalled()
  })

  it('rejects a duplicate decision from the same approver with 409', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(pendingRequest)
    mockDb.subAccount.findMany.mockResolvedValue([{ childUserId: CHILD }])
    mockDb.approval.create.mockRejectedValue(uniqueViolation())

    await expect(decide('req-1', CHILD, true, undefined)).rejects.toMatchObject(
      { statusCode: 409 }
    )
  })

  it('rejects a decision on a request that is no longer PENDING', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue({
      ...pendingRequest,
      status: 'EXPIRED',
    })

    await expect(decide('req-1', CHILD, true, undefined)).rejects.toMatchObject(
      { statusCode: 409 }
    )
  })
})

describe('cancel', () => {
  const request = {
    id: 'req-1',
    userId: CHILD,
    actingAsUserId: PARENT,
    status: 'PENDING',
  }

  it('allows the requester to cancel', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(request)
    mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 1 })

    const result = await cancel('req-1', PARENT)

    expect(result).toEqual({ status: 'CANCELLED' })
    expect(mockDispatch).toHaveBeenCalledWith(
      'approval.cancelled',
      expect.objectContaining({ requestId: 'req-1' })
    )
  })

  it('rejects cancellation from an unrelated user', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(request)

    await expect(cancel('req-1', 'stranger')).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(mockDb.approvalRequest.updateMany).not.toHaveBeenCalled()
  })

  it('allows an admin to cancel regardless of ownership', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue(request)
    mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 1 })

    const result = await cancel('req-1', 'admin-key-1', { isAdmin: true })

    expect(result).toEqual({ status: 'CANCELLED' })
  })

  it('rejects cancelling a request that is no longer PENDING', async () => {
    mockDb.approvalRequest.findUnique.mockResolvedValue({
      ...request,
      status: 'EXECUTED',
    })
    mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 0 })

    await expect(cancel('req-1', PARENT)).rejects.toMatchObject({
      statusCode: 409,
    })
  })
})

describe('AppError shape', () => {
  it('carries statusCode and message', () => {
    const err = new AppError(404, 'not found')
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('not found')
  })
})
