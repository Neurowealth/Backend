// Liquidation monitor (#532).
//
// The monitor is the one place in the product that decides to take a user's
// collateral without asking them, so its tests are about the decisions being
// narrow and auditable rather than about the arithmetic (that is
// tests/unit/lending/risk.test.ts):
//
//   1. A healthy loan is valued, recorded, and left completely alone.
//   2. A breached loan produces exactly one Transaction + outbox op, together.
//   3. A loan whose sale is already in flight is not queued a second time.
//   4. One loan blowing up does not stop the sweep.
//   5. An out-of-cycle request is consumed by exactly ONE sweep — the
//      regression that pinned a tripped circuit breaker to out-of-cycle sweeps
//      for the life of the process.
//
// db and the outbox are mocked, so nothing here touches a network or Postgres.

process.env.NODE_ENV = 'test'

import db from '../../../src/db'
import { enqueueOutboxOp } from '../../../src/outbox/service'
import { dispatchInBackground } from '../../../src/outbox/dispatcher'
import { accrueInterest } from '../../../src/lending/accrual'
import {
  LOAN_LIQUIDATION_JOB_NAME,
  requestOutOfCycleCheck,
  runLiquidationSweep,
  runOutOfCycleCheckIfRequested,
} from '../../../src/jobs/loanLiquidationMonitor'

jest.mock('../../../src/db', () => {
  const collateralLoanFindMany = jest.fn()
  const collateralLoanUpdate = jest.fn()
  const outboxOpFindFirst = jest.fn()
  const transactionCreate = jest.fn()
  const tx: any = {
    outboxOp: { findFirst: outboxOpFindFirst },
    transaction: { create: transactionCreate },
  }
  const client: any = {
    collateralLoan: {
      findMany: collateralLoanFindMany,
      update: collateralLoanUpdate,
    },
    $transaction: jest.fn(async (fn: (t: any) => unknown) => fn(tx)),
  }
  return {
    __esModule: true,
    default: client,
    __mockCollateralLoanFindMany: collateralLoanFindMany,
    __mockCollateralLoanUpdate: collateralLoanUpdate,
    __mockOutboxOpFindFirst: outboxOpFindFirst,
    __mockTransactionCreate: transactionCreate,
  }
})

jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: jest.fn(),
}))

jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchInBackground: jest.fn(),
}))

// Accrual is exercised directly in tests/unit/lending/accrual.test.ts. Here it
// is stubbed so the monitor's decision can be driven from an exact debt figure.
jest.mock('../../../src/lending/accrual', () => ({
  accrueInterest: jest.fn(),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const dbMock = require('../../../src/db')
const mockFindMany: jest.Mock = dbMock.__mockCollateralLoanFindMany
const mockUpdate: jest.Mock = dbMock.__mockCollateralLoanUpdate
const mockFindFirst: jest.Mock = dbMock.__mockOutboxOpFindFirst
const mockTransactionCreate: jest.Mock = dbMock.__mockTransactionCreate
const mockEnqueue = enqueueOutboxOp as jest.Mock
const mockDispatch = dispatchInBackground as jest.Mock
const mockAccrue = accrueInterest as jest.Mock

const NOW = new Date('2026-09-29T12:00:00.000Z')

/**
 * A loan with 10,000 of collateral. `debt` is what the monitor will see after
 * accrual; `threshold` is frozen on the loan at origination.
 */
function loan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loan-1',
    userId: 'user-1',
    positionId: 'pos-1',
    borrowedAsset: 'USDC',
    principalAmount: 1000,
    interestAccrued: 0,
    interestAccruedTo: NOW,
    interestRateApy: 0.08,
    liquidationLtvThreshold: 0.75,
    position: {
      assetSymbol: 'XLM',
      currentValue: 10_000,
      user: { network: 'PUBLIC' },
    },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAccrue.mockImplementation(async (id: string) => ({
    ...loan({ id }),
    interestAccruedTo: NOW,
  }))
  mockFindFirst.mockResolvedValue(null)
  mockTransactionCreate.mockImplementation(async ({ data }: any) => ({
    id: `tx-${data.loanId}`,
    ...data,
  }))
  mockEnqueue.mockImplementation(async (_tx: any, op: any) => ({
    id: 'op-1',
    ...op,
  }))
})

describe('src/jobs/loanLiquidationMonitor — decisions', () => {
  it('values a healthy loan and leaves it alone', async () => {
    // 1,000 of debt against 10,000 of collateral is 10% LTV. The whole point
    // of the product is that this loan keeps earning yield, so a healthy loan
    // must produce no Transaction, no outbox op, and no dispatch at all.
    mockAccrue.mockResolvedValue(loan({ principalAmount: 1000 }))
    mockFindMany.mockResolvedValue([loan()])

    const result = await runLiquidationSweep()

    expect(result).toMatchObject({
      scanned: 1,
      triggered: 0,
      enqueued: 0,
      failed: 0,
    })
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastValuedCollateral: 10_000 }),
      })
    )
    expect(mockTransactionCreate).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('does not fire one basis point below the threshold', async () => {
    // Exactly the boundary the frozen threshold exists for.
    mockAccrue.mockResolvedValue(loan({ principalAmount: 7499 }))
    mockFindMany.mockResolvedValue([loan()])

    const result = await runLiquidationSweep()
    expect(result.triggered).toBe(0)
  })

  it('fires at the threshold exactly', async () => {
    mockAccrue.mockResolvedValue(loan({ principalAmount: 7500 }))
    mockFindMany.mockResolvedValue([loan()])

    const result = await runLiquidationSweep()
    expect(result).toMatchObject({ triggered: 1, enqueued: 1, failed: 0 })
  })

  it('enqueues the sale and its ledger row together, and dispatches it', async () => {
    mockAccrue.mockResolvedValue(loan({ principalAmount: 8000 }))
    mockFindMany.mockResolvedValue([loan()])

    const result = await runLiquidationSweep()

    expect(result).toMatchObject({ triggered: 1, enqueued: 1 })
    expect(mockTransactionCreate).toHaveBeenCalledTimes(1)
    const txData = mockTransactionCreate.mock.calls[0][0].data
    expect(txData).toMatchObject({
      loanId: 'loan-1',
      type: 'LOAN_LIQUIDATION',
      status: 'PENDING',
      assetSymbol: 'XLM',
      amount: 10_000,
    })
    // The loan id rides on the Transaction, which is what makes a failed
    // settlement reconcilable rather than orphaned.
    expect(txData.loanId).toBe('loan-1')
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue.mock.calls[0][1]).toMatchObject({
      kind: 'LOAN_LIQUIDATION',
      actor: 'SYSTEM',
      idempotencyKey: `LOAN_LIQUIDATION:loan-1:${NOW.getTime()}`,
    })
    expect(mockDispatch).toHaveBeenCalledWith('op-1')
  })

  it('keys the enqueue on the accrual watermark, so a retried sweep is idempotent', async () => {
    mockAccrue.mockResolvedValue(loan({ principalAmount: 8000 }))
    mockFindMany.mockResolvedValue([loan()])

    await runLiquidationSweep()
    await runLiquidationSweep()

    const keys = mockEnqueue.mock.calls.map((c) => c[1].idempotencyKey)
    expect(keys).toEqual([keys[0], keys[0]])
  })

  it('does not queue a second sale while one is already in flight', async () => {
    mockAccrue.mockResolvedValue(loan({ principalAmount: 8000 }))
    mockFindMany.mockResolvedValue([loan()])
    mockFindFirst.mockResolvedValue({ id: 'op-existing' })

    const result = await runLiquidationSweep()

    // Triggered but not enqueued: the breach is real, the queue is not the
    // place to express it twice.
    expect(result).toMatchObject({ triggered: 1, enqueued: 0, failed: 0 })
    expect(mockTransactionCreate).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('isolates a failing loan from the rest of the sweep', async () => {
    // A single unreadable loan must not stop the sweep from protecting the
    // others — the alternative is that one bad row disables liquidations.
    mockAccrue.mockImplementation(async (id: string) => {
      if (id === 'loan-bad') throw new Error('connection reset')
      return loan({ id, principalAmount: 8000 })
    })
    mockFindMany.mockResolvedValue([
      loan({ id: 'loan-bad' }),
      loan({ id: 'loan-ok' }),
    ])

    const result = await runLiquidationSweep()

    expect(result).toMatchObject({
      scanned: 2,
      triggered: 1,
      enqueued: 1,
      failed: 1,
    })
    expect(mockEnqueue.mock.calls[0][1].payload.loanId).toBe('loan-ok')
  })
})

describe('src/jobs/loanLiquidationMonitor — out-of-cycle requests', () => {
  it('is a no-op when nothing was requested', async () => {
    mockFindMany.mockResolvedValue([])

    await expect(
      runOutOfCycleCheckIfRequested('circuit breaker')
    ).resolves.toBeNull()
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('consumes the request on the next check', async () => {
    mockFindMany.mockResolvedValue([])
    requestOutOfCycleCheck('abnormal_loss')

    const result = await runOutOfCycleCheckIfRequested('circuit breaker')
    expect(result).toMatchObject({ outOfCycle: true, scanned: 0 })

    // ...and only once. This is the regression: a request consumed by a
    // circuit_breaker sweep used to leave the flag set, so every subsequent
    // scheduled tick ran a second, duplicate sweep forever.
    await expect(
      runOutOfCycleCheckIfRequested('circuit breaker')
    ).resolves.toBeNull()
  })

  it('is also consumed by a plain scheduled sweep', async () => {
    mockFindMany.mockResolvedValue([])
    requestOutOfCycleCheck('abnormal_loss')

    const result = await runLiquidationSweep()
    expect(result.outOfCycle).toBe(true)
    await expect(
      runOutOfCycleCheckIfRequested('circuit breaker')
    ).resolves.toBeNull()
  })

  it('does not lose a request that arrives mid-sweep', async () => {
    // Trip the breaker from inside the first sweep — i.e. after it has already
    // consumed the (empty) request and passed the entry check, but before it
    // finishes. The request must survive to the next sweep rather than being
    // overwritten by the one this sweep is about to clear.
    let calls = 0
    mockFindMany.mockImplementation(async () => {
      if (calls++ === 0) requestOutOfCycleCheck('abnormal_loss')
      return []
    })

    await runLiquidationSweep()
    expect(
      await runOutOfCycleCheckIfRequested('circuit breaker')
    ).not.toBeNull()
    await expect(
      runOutOfCycleCheckIfRequested('circuit breaker')
    ).resolves.toBeNull()
  })
})

describe('src/jobs/loanLiquidationMonitor — job identity', () => {
  it('has a stable job name', () => {
    expect(LOAN_LIQUIDATION_JOB_NAME).toBe('loan-liquidation-monitor')
  })
})
