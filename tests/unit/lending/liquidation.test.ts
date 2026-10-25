// Protective collateral sale (#532).
//
// This is the one path in the platform that takes a user's position without
// their consent, so the tests are organised around the guarantees that make it
// defensible rather than around coverage:
//
//   1. It re-verifies health at execution time and does nothing if the position
//      healed while the op sat in the queue.
//   2. A replayed or already-settled loan is a no-op, not a second sale.
//   3. A sale that runs is atomic: collateral, debt, loan, event, bad debt and
//      the ledger row all move together or not at all.
//   4. Partial sales are pro-rata and take the yield with them; full sales
//      close the position.
//   5. Nothing on-chain is invented — the reference is a namespaced platform
//      string, and the user is always told.
//   6. `force` is the only way past the health check, and it is explicit.

process.env.NODE_ENV = 'test'

import { config } from '../../../src/config/env'
import {
  applyLoanLiquidationSale,
  liquidationReference,
} from '../../../src/lending/liquidation'
import { publishUserEvent } from '../../../src/events/publisher'
import { dispatchWebhookEvent } from '../../../src/services/webhookDispatcher'
import { alertingService } from '../../../src/services/alerting'

jest.mock('../../../src/db', () => {
  const findUnique = jest.fn()
  const positionUpdate = jest.fn()
  const collateralLoanUpdate = jest.fn()
  const loanLiquidationEventCreate = jest.fn()
  const platformBadDebtCreate = jest.fn()
  const transactionUpdate = jest.fn()
  const tx: any = {
    collateralLoan: { findUnique, update: collateralLoanUpdate },
    position: { update: positionUpdate },
    loanLiquidationEvent: { create: loanLiquidationEventCreate },
    platformBadDebt: { create: platformBadDebtCreate },
    transaction: { update: transactionUpdate },
  }
  const client: any = {
    $transaction: jest.fn(async (fn: (t: any) => unknown) => fn(tx)),
  }
  return {
    __esModule: true,
    default: client,
    db: client,
    __mockFindUnique: findUnique,
    __mockPositionUpdate: positionUpdate,
    __mockCollateralLoanUpdate: collateralLoanUpdate,
    __mockEventCreate: loanLiquidationEventCreate,
    __mockBadDebtCreate: platformBadDebtCreate,
    __mockTransactionUpdate: transactionUpdate,
  }
})

// Accrual is stubbed: the sale must decide on the FRESH balance, and the fact
// that it re-reads after accruing is asserted from the second findUnique.
jest.mock('../../../src/lending/accrual', () => ({
  accrueInterest: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn(),
}))
jest.mock('../../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const dbMock = require('../../../src/db')
const mockFindUnique: jest.Mock = dbMock.__mockFindUnique
const mockPositionUpdate: jest.Mock = dbMock.__mockPositionUpdate
const mockLoanUpdate: jest.Mock = dbMock.__mockCollateralLoanUpdate
const mockEventCreate: jest.Mock = dbMock.__mockEventCreate
const mockBadDebtCreate: jest.Mock = dbMock.__mockBadDebtCreate
const mockTransactionUpdate: jest.Mock = dbMock.__mockTransactionUpdate
const mockPublish = publishUserEvent as jest.Mock
const mockWebhook = dispatchWebhookEvent as jest.Mock
const mockEmit = alertingService.emit as jest.Mock

const SEQUENCE = 1_757_000_000_000

function payload(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    loanId: 'loan-1',
    positionId: 'pos-1',
    collateralAmount: 10_000,
    collateralAssetSymbol: 'XLM',
    debtOutstanding: 8_000,
    borrowedAsset: 'USDC',
    trigger: 'scheduled' as const,
    transactionId: 'tx-1',
    sequence: SEQUENCE,
    ...overrides,
  }
}

/** 8,000 of debt against 10,000 of collateral: LTV 0.8, over the 0.75 line. */
function loan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loan-1',
    userId: 'user-1',
    positionId: 'pos-1',
    status: 'ACTIVE',
    borrowedAsset: 'USDC',
    principalAmount: 8_000,
    interestAccrued: 0,
    interestAccruedTo: new Date(),
    interestRateApy: 8,
    liquidationLtvThreshold: 0.75,
    position: {
      id: 'pos-1',
      status: 'ACTIVE',
      assetSymbol: 'XLM',
      depositedAmount: 1_000,
      currentValue: 10_000,
      yieldEarned: 200,
    },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  // The executor reads the loan, accrues, then reads it AGAIN. Both reads get
  // the same row unless a test says otherwise.
  mockFindUnique.mockResolvedValue(loan())
  mockEventCreate.mockResolvedValue({ id: 'event-1' })
})

describe('src/lending/liquidation — the reference', () => {
  it('is namespaced so nothing mistakes a netting entry for a Stellar hash', () => {
    const ref = liquidationReference('loan-1', SEQUENCE)
    expect(ref).toBe(`platform:liquidation:loan-1:${SEQUENCE}`)
    // 64 hex characters is what every on-chain identifier looks like. If this
    // ever started matching, a downstream "is this confirmed on Horizon?"
    // check would go looking for a payment that does not exist.
    expect(ref).not.toMatch(/^[0-9a-f]{64}$/i)
    expect(ref.startsWith('platform:')).toBe(true)
  })
})

describe('src/lending/liquidation — refusing to act', () => {
  it('does nothing when the loan is not ACTIVE', async () => {
    // The outbox redelivers. A settled loan must not be sold twice.
    mockFindUnique.mockResolvedValue(loan({ status: 'REPAID' }))

    const result = await applyLoanLiquidationSale(payload())

    expect(result.hash).toBe(liquidationReference('loan-1', SEQUENCE))
    expect(mockPositionUpdate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('does nothing when the loan no longer exists', async () => {
    mockFindUnique.mockResolvedValue(null)

    await applyLoanLiquidationSale(payload())
    expect(mockPositionUpdate).not.toHaveBeenCalled()
  })

  it('re-checks health at execution time and stands down if the position healed', async () => {
    // The monitor decided minutes ago. Collateral can recover in between, and
    // selling a position that is back inside its threshold would be taking
    // someone's yield for nothing.
    const healed = loan({
      principalAmount: 1_000,
      position: { ...loan().position, currentValue: 10_000 },
    })
    mockFindUnique.mockResolvedValue(healed)

    const result = await applyLoanLiquidationSale(payload())

    expect(result.status).toBe('success')
    expect(mockPositionUpdate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('decides on the balance it re-read after accruing, not the one it was handed', async () => {
    // A loan that was marginal when queued but grew into a real breach while in
    // flight must still be liquidated. If the sale trusted the payload's
    // debtOutstanding, interest would never count toward a liquidation.
    const stale = loan({
      principalAmount: 7_400,
      position: { ...loan().position, currentValue: 10_000 },
    })
    const breached = loan({ principalAmount: 8_000 })
    mockFindUnique.mockResolvedValueOnce(stale).mockResolvedValueOnce(breached)

    await applyLoanLiquidationSale(payload({ debtOutstanding: 7_400 }))

    expect(mockEventCreate).toHaveBeenCalledTimes(1)
  })

  it('sells nothing when the plan cannot retire or write off anything', async () => {
    // Defensive: a plan with no sale and no shortfall means there is no action,
    // and inventing one would derecognise collateral for no reason.
    mockFindUnique.mockResolvedValue(
      loan({
        principalAmount: 0.01,
        position: { ...loan().position, currentValue: 10_000 },
      })
    )

    await applyLoanLiquidationSale(payload())
    expect(mockPositionUpdate).not.toHaveBeenCalled()
  })
})

describe('src/lending/liquidation — performing the sale', () => {
  it('derecognises collateral pro-rata and retires the debt in one transaction', async () => {
    const result = await applyLoanLiquidationSale(payload())

    expect(result.status).toBe('success')

    // 5,000 of 10,000 sold is half the position: half the deposit, half the
    // yield, half the value. Leaving the yield behind would let a liquidated
    // position bank yield it never earned.
    const pos = mockPositionUpdate.mock.calls[0][0]
    expect(pos.data).toMatchObject({
      depositedAmount: 500,
      currentValue: 5_000,
      yieldEarned: 100,
    })

    const loanUpdate = mockLoanUpdate.mock.calls[0][0].data
    expect(loanUpdate).toMatchObject({
      principalAmount: 3_000,
      interestAccrued: 0,
      status: 'ACTIVE',
      lastValuedCollateral: 5_000,
      liquidationOutboxOpId: 'tx-1',
    })

    // Everything above happened inside the single $transaction that also holds
    // the outbox exactly-once claim.
    expect(dbMock.default.$transaction).toHaveBeenCalledTimes(1)
  })

  it('records an immutable event for every sale', async () => {
    await applyLoanLiquidationSale(payload())

    expect(mockEventCreate).toHaveBeenCalledTimes(1)
    const event = mockEventCreate.mock.calls[0][0].data
    expect(event).toMatchObject({
      loanId: 'loan-1',
      userId: 'user-1',
      trigger: 'scheduled',
      kind: 'PARTIAL',
      collateralSold: 5_000,
      debtRetired: 5_000,
      shortfall: 0,
    })
    expect(event.ltvBefore).toBeCloseTo(0.8, 9)
    expect(event.ltvAfter).toBeCloseTo(0.6, 6)
  })

  it('closes the position when the whole collateral is sold', async () => {
    // 1,000 of collateral against 8,000 of debt: everything goes, and the
    // remaining 7,000 is the platform's loss.
    mockFindUnique.mockResolvedValue(
      loan({
        position: {
          ...loan().position,
          currentValue: 1_000,
          depositedAmount: 100,
        },
      })
    )

    await applyLoanLiquidationSale(payload())

    expect(mockPositionUpdate.mock.calls[0][0].data).toMatchObject({
      status: 'CLOSED',
      currentValue: 0,
    })
    expect(mockLoanUpdate.mock.calls[0][0].data).toMatchObject({
      principalAmount: 0,
      status: 'LIQUIDATED',
    })
  })

  it('books the uncovered remainder as bad debt, and nothing for a covered sale', async () => {
    mockFindUnique.mockResolvedValue(
      loan({
        position: {
          ...loan().position,
          currentValue: 1_000,
          depositedAmount: 100,
        },
      })
    )

    await applyLoanLiquidationSale(payload())
    expect(mockBadDebtCreate).toHaveBeenCalledTimes(1)
    expect(mockBadDebtCreate.mock.calls[0][0].data).toMatchObject({
      loanId: 'loan-1',
      assetSymbol: 'USDC',
      amount: 7_000,
      status: 'OPEN',
    })

    // A sale the collateral fully covers must not open a loss record: bad debt
    // is the platform losing money, and a fully covered liquidation is just a
    // margin call succeeding.
    mockBadDebtCreate.mockClear()
    mockEventCreate.mockClear()
    mockFindUnique.mockResolvedValue(loan())
    await applyLoanLiquidationSale(payload({ transactionId: 'tx-2' }))
    expect(mockEventCreate).toHaveBeenCalledTimes(1)
    expect(mockEventCreate.mock.calls[0][0].data.shortfall).toBe(0)
    expect(mockBadDebtCreate).not.toHaveBeenCalled()
  })

  it('honours maxCollateralFractionSold as a per-sale cap, not a per-loan one', async () => {
    const original = config.lending.maxCollateralFractionSold
    ;(config.lending as any).maxCollateralFractionSold = 0.1
    try {
      await applyLoanLiquidationSale(payload())
      const sold = mockEventCreate.mock.calls[0][0].data.collateralSold
      expect(sold).toBeCloseTo(1_000, 6)
      // Still ACTIVE, because collateral worth 9,000 still backs the rest.
      expect(mockLoanUpdate.mock.calls[0][0].data.status).toBe('ACTIVE')
    } finally {
      ;(config.lending as any).maxCollateralFractionSold = original
    }
  })

  it('mirrors the netting entry onto the ledger row with a platform reference', async () => {
    await applyLoanLiquidationSale(payload())

    const update = mockTransactionUpdate.mock.calls[0][0]
    expect(update.where).toEqual({ id: 'tx-1' })
    expect(update.data).toMatchObject({
      amount: 5_000,
      status: 'CONFIRMED',
      txHash: liquidationReference('loan-1', SEQUENCE),
    })
    expect(update.data.txHash.startsWith('platform:')).toBe(true)
  })
})

describe('src/lending/liquidation — telling the user', () => {
  it('notifies, webhooks and alerts after a successful sale', async () => {
    // A forced sale the user never authorised is never a silent ledger change.
    await applyLoanLiquidationSale(payload())

    expect(mockPublish).toHaveBeenCalledWith(
      'user-1',
      'transactions',
      'loan.liquidation_executed',
      expect.objectContaining({ loanId: 'loan-1', collateralSold: 5_000 })
    )
    expect(mockWebhook).toHaveBeenCalledWith(
      'loan.liquidation_executed',
      expect.objectContaining({ userId: 'user-1' })
    )
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning', component: 'lending' }),
      `lending:liquidation:loan-1:${SEQUENCE}`
    )
  })

  it('raises a critical, per-loan-keyed alert on a charge-off', async () => {
    mockFindUnique.mockResolvedValue(
      loan({
        position: {
          ...loan().position,
          currentValue: 1_000,
          depositedAmount: 100,
        },
      })
    )

    await applyLoanLiquidationSale(payload())

    // Keyed per loan so one bad loan cannot spam the operator channel.
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical' }),
      'lending:charge_off:loan-1'
    )
    expect(mockWebhook).toHaveBeenCalledWith(
      'loan.charged_off',
      expect.objectContaining({ amount: 7_000, assetSymbol: 'USDC' })
    )
  })

  it('still completes the sale when notification fails', async () => {
    // The sale is correct and committed; a dead webhook endpoint is an
    // operational problem, not a reason to re-take the collateral.
    mockPublish.mockRejectedValueOnce(new Error('socket hang up'))

    const result = await applyLoanLiquidationSale(payload())

    expect(result.status).toBe('success')
    expect(mockEventCreate).toHaveBeenCalledTimes(1)
  })
})

describe('src/lending/liquidation — force', () => {
  it('leaves a healthy position strictly alone', async () => {
    const healthy = loan({
      principalAmount: 1_000,
      position: { ...loan().position, currentValue: 10_000 },
    })
    mockFindUnique.mockResolvedValue(healthy)

    await applyLoanLiquidationSale(payload())
    expect(mockPositionUpdate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('settles the debt without taking the whole position when forced', async () => {
    // The operator is asking for the loan to be closed at today's price, not
    // for the collateral to be confiscated. 1,000 of debt against 10,000 of
    // collateral must sell 1,000 and leave 9,000 with the user.
    const healthy = loan({
      principalAmount: 1_000,
      position: { ...loan().position, currentValue: 10_000 },
    })
    mockFindUnique.mockResolvedValue(healthy)

    await applyLoanLiquidationSale(payload(), { force: true })

    const event = mockEventCreate.mock.calls[0][0].data
    expect(event.collateralSold).toBeCloseTo(1_000, 6)
    expect(event.debtRetired).toBeCloseTo(1_000, 6)
    expect(event.shortfall).toBe(0)
    expect(mockPositionUpdate.mock.calls[0][0].data).toMatchObject({
      currentValue: 9_000,
      depositedAmount: 900,
    })
    // The loan is settled, not charged off.
    expect(mockLoanUpdate.mock.calls[0][0].data).toMatchObject({
      principalAmount: 0,
      status: 'LIQUIDATED',
    })
    expect(mockBadDebtCreate).not.toHaveBeenCalled()
  })

  it('still writes off the difference when a forced sale cannot cover the debt', async () => {
    const underwater = loan({
      principalAmount: 8_000,
      position: {
        ...loan().position,
        currentValue: 1_000,
        depositedAmount: 100,
      },
    })
    mockFindUnique.mockResolvedValue(underwater)

    await applyLoanLiquidationSale(payload(), { force: true })

    expect(mockBadDebtCreate.mock.calls[0][0].data).toMatchObject({
      amount: 7_000,
    })
  })
})
