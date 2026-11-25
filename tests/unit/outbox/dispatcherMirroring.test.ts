/**
 * How the dispatcher mirrors an op's outcome onto linked rows (#822, #823,
 * #824, #825). The outbox service and executors are mocked, so these pin the
 * dispatcher's decisions: WHEN it mirrors, and with what status.
 */

jest.mock('../../../src/config/env', () => ({
  config: {
    outbox: {
      maxAbsFee: 1_000_000,
      maxAttempts: 5,
      feeBumpMaxAttempts: 3,
      feeBumpMultiplier: 2,
      submittedTimeoutMs: 60_000,
      batchSize: 10,
      lowDeferMs: 1_000,
      lowMaxDeferMs: 10_000,
      globalMaxInFlight: 10,
      perAccountMaxInFlight: 1,
    },
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: { outboxOp: { update: jest.fn() } },
}))
jest.mock('../../../src/utils/metrics', () => ({
  recordOutboxOp: jest.fn(),
  recordOutboxFeeBump: jest.fn(),
  recordOutboxLatency: jest.fn(),
  updateOutboxQueueDepth: jest.fn(),
  updateOutboxStuckSubmitted: jest.fn(),
  recordOutboxLowDeferred: jest.fn(),
  recordOutboxAggressiveFeeUsed: jest.fn(),
  recordOutboxMaxFeeHit: jest.fn(),
}))
jest.mock('../../../src/stellar/feeOracle', () => ({
  getFeeSnapshot: () => ({
    congestionLevel: 'low',
    recommendedBaseFee: 100,
    aggressiveBaseFee: 1_000,
  }),
  isStale: () => false,
}))
jest.mock('../../../src/stellar/client', () => ({
  getTransactionStatus: jest.fn(),
}))
jest.mock('../../../src/outbox/signerLock', () => ({
  getSignerLock: () => ({
    withLock: (_key: string, fn: () => unknown) => fn(),
    hasCapacity: () => true,
  }),
}))
jest.mock('../../../src/outbox/executors', () => ({
  executeOutboxPayload: jest.fn(),
  resolveSignerPublicKey: jest.fn().mockResolvedValue('GSIGNER'),
}))
jest.mock('../../../src/outbox/service', () => ({
  claimOp: jest.fn(),
  clearStaleSubmittedTxHash: jest.fn(),
  findClaimableOps: jest.fn().mockResolvedValue([]),
  findStuckSubmittedOps: jest.fn().mockResolvedValue([]),
  getOp: jest.fn(),
  getQueueStats: jest.fn().mockResolvedValue({}),
  isUserHalted: jest.fn().mockResolvedValue(false),
  markConfirmed: jest.fn(),
  markFailedOrRetry: jest.fn(),
  markFailedTerminal: jest.fn(),
  mirrorLinkedTransaction: jest.fn(),
  mirrorPendingTransaction: jest.fn(),
  recordSubmittedTxHash: jest.fn(),
  returnStuckOpToPending: jest.fn(),
}))

import { dispatchOne, runDispatchSweep } from '../../../src/outbox/dispatcher'
import { executeOutboxPayload } from '../../../src/outbox/executors'
import { InvalidOutboxPayloadError } from '../../../src/outbox/errors'
import * as service from '../../../src/outbox/service'
import { getTransactionStatus } from '../../../src/stellar/client'

const mocked = service as jest.Mocked<typeof service>
const mockExecute = executeOutboxPayload as jest.Mock
const mockChainStatus = getTransactionStatus as jest.Mock

function op(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'op-1',
    idempotencyKey: 'k',
    userId: 'u1',
    kind: 'WITHDRAW',
    actor: 'SYSTEM',
    payload: {
      method: 'withdraw',
      userId: 'u1',
      userAddress: 'GUSER',
      amount: 10,
      assetSymbol: 'USDC',
      transactionId: 'tx-1',
    },
    priority: 'CRITICAL',
    status: 'PENDING',
    txHash: null,
    attempts: 1,
    nextAttemptAt: null,
    error: null,
    submittedAt: new Date(),
    confirmedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    signerPublicKey: 'GSIGNER',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mocked.getOp.mockResolvedValue(op())
  mocked.claimOp.mockResolvedValue(op({ status: 'SUBMITTED' }))
  mocked.findClaimableOps.mockResolvedValue([])
  mocked.findStuckSubmittedOps.mockResolvedValue([])
})

describe('confirmations mirror exactly once (#824)', () => {
  it('mirrors CONFIRMED when this call made the transition', async () => {
    mockExecute.mockResolvedValue({ hash: 'h1', status: 'success' })
    mocked.markConfirmed.mockResolvedValue(true)

    await dispatchOne('op-1')

    expect(mocked.mirrorLinkedTransaction).toHaveBeenCalledWith(
      expect.anything(),
      { txHash: 'h1', status: 'CONFIRMED' }
    )
  })

  it('does not mirror when another path already confirmed the op', async () => {
    mockExecute.mockResolvedValue({ hash: 'h1', status: 'success' })
    mocked.markConfirmed.mockResolvedValue(false)

    await dispatchOne('op-1')

    expect(mocked.mirrorLinkedTransaction).not.toHaveBeenCalled()
  })

  it('does not mirror when the stuck-op sweep loses the confirmation race', async () => {
    mocked.findStuckSubmittedOps.mockResolvedValue([
      op({ status: 'SUBMITTED', txHash: 'h1' }),
    ])
    mockChainStatus.mockResolvedValue('success')
    mocked.markConfirmed.mockResolvedValue(false)

    await runDispatchSweep()

    expect(mocked.markConfirmed).toHaveBeenCalledWith('op-1', 'h1')
    expect(mocked.mirrorLinkedTransaction).not.toHaveBeenCalled()
  })
})

describe('skipped results are not reported as completed movements (#823)', () => {
  it('confirms the op but never mirrors the linked row as CONFIRMED', async () => {
    mockExecute.mockResolvedValue({
      hash: 'platform:liquidation:loan-1:1',
      status: 'success',
      skipped: true,
    })
    mocked.markConfirmed.mockResolvedValue(true)

    const result = await dispatchOne('op-1')

    expect(result.skipped).toBe(true)
    expect(mocked.markConfirmed).toHaveBeenCalled()
    expect(mocked.mirrorLinkedTransaction).not.toHaveBeenCalled()
  })
})

describe('fee-bump cap failures mirror to the linked row (#822)', () => {
  const capped = () =>
    op({ status: 'SUBMITTED', txHash: 'h-stale', attempts: 3 })

  it('mirrors FAILED when the forced-terminal transition applies', async () => {
    mocked.findStuckSubmittedOps.mockResolvedValue([capped()])
    mockChainStatus.mockResolvedValue('not_found')
    mocked.markFailedOrRetry.mockResolvedValue({
      terminal: true,
      applied: true,
    })

    await runDispatchSweep()

    expect(mocked.markFailedOrRetry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'op-1' }),
      expect.stringContaining('fee-bump'),
      { forceTerminal: true }
    )
    // not_found cleared the stale hash, so only the status mirrors.
    expect(mocked.mirrorLinkedTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1' }),
      { txHash: undefined, status: 'FAILED' }
    )
  })

  it('does not mirror again when the failure was already applied', async () => {
    mocked.findStuckSubmittedOps.mockResolvedValue([capped()])
    mockChainStatus.mockResolvedValue('not_found')
    mocked.markFailedOrRetry.mockResolvedValue({
      terminal: false,
      applied: false,
    })

    await runDispatchSweep()

    expect(mocked.mirrorLinkedTransaction).not.toHaveBeenCalled()
  })
})

describe('invalid payloads fail terminally on the first attempt (#825)', () => {
  it('forces the terminal branch and mirrors FAILED', async () => {
    mockExecute.mockRejectedValue(
      new InvalidOutboxPayloadError('no valid recipient address')
    )
    mocked.markFailedOrRetry.mockResolvedValue({
      terminal: true,
      applied: true,
    })

    await expect(dispatchOne('op-1')).rejects.toThrow(
      'no valid recipient address'
    )

    expect(mocked.markFailedOrRetry).toHaveBeenCalledWith(
      expect.anything(),
      'no valid recipient address',
      { forceTerminal: true }
    )
    expect(mocked.mirrorLinkedTransaction).toHaveBeenCalledWith(
      expect.anything(),
      { status: 'FAILED' }
    )
  })

  it('still retries ordinary submission errors', async () => {
    mockExecute.mockRejectedValue(new Error('rpc down'))
    mocked.markFailedOrRetry.mockResolvedValue({
      terminal: false,
      applied: true,
    })

    await expect(dispatchOne('op-1')).rejects.toThrow('rpc down')

    expect(mocked.markFailedOrRetry).toHaveBeenCalledWith(
      expect.anything(),
      'rpc down',
      { forceTerminal: false }
    )
  })
})
