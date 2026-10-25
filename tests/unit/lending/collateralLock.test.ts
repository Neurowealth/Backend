// Collateral lock (#532).
//
// The lock is the guarantee that makes the whole product honest: capital that
// backs a loan cannot be withdrawn or rebalanced away. Its tests are about the
// guarantees, and in particular about the fact that the lock is DERIVED from
// the loan rather than stored:
//
//   1. A position is locked exactly while an ACTIVE loan points at it.
//   2. The withdraw guard is scoped the way the withdraw path already scopes
//      itself, so unlocking one position does not block another's.
//   3. A settled loan releases the collateral immediately — no reconciliation
//      step, no stale flag.
//   4. The refusal names the loan and the exact amount, because a user told
//      "409" with no numbers will file a support ticket.

process.env.NODE_ENV = 'test'

import db from '../../../src/db'
import {
  assertCollateralNotLocked,
  getActiveLoanForPosition,
  getLockedPositionIds,
  listActiveLoansForUser,
  loanOutstanding,
} from '../../../src/lending/collateralLock'
import { AppError } from '../../../src/utils/errors'

jest.mock('../../../src/db', () => {
  const positionFindMany = jest.fn()
  const collateralLoanFindMany = jest.fn()
  const collateralLoanFindFirst = jest.fn()
  const client: any = {
    position: { findMany: positionFindMany },
    collateralLoan: {
      findMany: collateralLoanFindMany,
      findFirst: collateralLoanFindFirst,
    },
  }
  return {
    __esModule: true,
    default: client,
    __mockPositionFindMany: positionFindMany,
    __mockLoanFindMany: collateralLoanFindMany,
    __mockLoanFindFirst: collateralLoanFindFirst,
  }
})

const dbMock = require('../../../src/db')
const mockPositionFindMany: jest.Mock = dbMock.__mockPositionFindMany
const mockLoanFindMany: jest.Mock = dbMock.__mockLoanFindMany
const mockLoanFindFirst: jest.Mock = dbMock.__mockLoanFindFirst

const FROM = new Date('2026-01-01T00:00:00.000Z')
const HALF_YEAR = new Date(FROM.getTime() + 182.5 * 24 * 60 * 60 * 1000)

function loanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loan-1',
    userId: 'user-1',
    positionId: 'pos-1',
    borrowedAsset: 'USDC',
    principalAmount: 1_000,
    interestAccrued: 0,
    interestRateApy: 8,
    interestAccruedTo: FROM,
    liquidationLtvThreshold: 0.75,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLoanFindMany.mockResolvedValue([])
  mockLoanFindFirst.mockResolvedValue(null)
})

describe('src/lending/collateralLock — getLockedPositionIds', () => {
  it('asks the database nothing about an empty candidate list', async () => {
    // The rebalance loop calls this on every batch, including empty ones.
    const locked = await getLockedPositionIds([])
    expect(locked.size).toBe(0)
    expect(mockLoanFindMany).not.toHaveBeenCalled()
  })

  it('returns the locked subset of the candidates, and only ACTIVE loans', async () => {
    mockLoanFindMany.mockResolvedValue([{ positionId: 'pos-2' }])

    const locked = await getLockedPositionIds(['pos-1', 'pos-2', 'pos-3'])

    expect([...locked]).toEqual(['pos-2'])
    // The lock and the debt are one fact read two ways: querying status:
    // 'ACTIVE' here is what stops a REPAID loan from freezing collateral
    // forever.
    expect(mockLoanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          positionId: { in: ['pos-1', 'pos-2', 'pos-3'] },
          status: 'ACTIVE',
        },
      })
    )
  })

  it('de-duplicates when two active loans point at one position', async () => {
    // v1's partial unique index prevents this at the database, but the Set is
    // what keeps a duplicate from becoming a double-count in the agent's
    // filtered batch.
    mockLoanFindMany.mockResolvedValue([
      { positionId: 'pos-1' },
      { positionId: 'pos-1' },
    ])
    const locked = await getLockedPositionIds(['pos-1'])
    expect(locked.size).toBe(1)
  })
})

describe('src/lending/collateralLock — loan reads', () => {
  it('returns null for a position with no active loan', async () => {
    expect(await getActiveLoanForPosition('pos-1')).toBeNull()
  })

  it('converts Prisma Decimals to numbers at the boundary', async () => {
    // Decimals arrive as objects. Handing those to the arithmetic in risk.ts
    // would silently produce NaN in an LTV comparison.
    mockLoanFindFirst.mockResolvedValue(
      loanRow({ principalAmount: '1000.500000', interestRateApy: '8.000000' })
    )

    const loan = await getActiveLoanForPosition('pos-1')

    expect(loan).toMatchObject({
      principal: 1000.5,
      interestRateApy: 8,
      borrowedAsset: 'USDC',
    })
  })

  it('lists a user’s active loans oldest first', async () => {
    mockLoanFindMany.mockResolvedValue([
      loanRow({ id: 'loan-1' }),
      loanRow({ id: 'loan-2', positionId: 'pos-2' }),
    ])
    const loans = await listActiveLoansForUser('user-1')

    expect(loans.map((l) => l.id)).toEqual(['loan-1', 'loan-2'])
    expect(mockLoanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', status: 'ACTIVE' } })
    )
  })
})

describe('src/lending/collateralLock — loanOutstanding', () => {
  it('includes unbilled interest up to the moment asked', async () => {
    // A lock message that under-reports by a month of interest is a support
    // ticket: "you owe 1,000 but it says 1,020".
    const loan = {
      id: 'l',
      userId: 'u',
      positionId: 'p',
      borrowedAsset: 'USDC',
      principal: 1_000,
      interestAccrued: 0,
      interestRateApy: 8,
      interestAccruedTo: FROM,
      liquidationLtvThreshold: 0.75,
    }
    // 182.5/365.25 is very nearly but not exactly a half year (that is what a
    // 365.25-day year is FOR), so the expected figure is computed rather than
    // rounded: 1000 * 0.08 * (182.5/365.25) = 39.97.
    const expected = 1_000 + 1_000 * 0.08 * (182.5 / 365.25)
    expect(loanOutstanding(loan, HALF_YEAR)).toBeCloseTo(expected, 9)
  })

  it('includes already-billed interest on top', () => {
    expect(
      loanOutstanding(
        {
          id: 'l',
          userId: 'u',
          positionId: 'p',
          borrowedAsset: 'USDC',
          principal: 1_000,
          interestAccrued: 12.5,
          interestRateApy: 8,
          interestAccruedTo: HALF_YEAR,
          liquidationLtvThreshold: 0.75,
        },
        HALF_YEAR
      )
    ).toBeCloseTo(1_012.5, 6)
  })
})

describe('src/lending/collateralLock — assertCollateralNotLocked', () => {
  it('passes when the user has no matching positions at all', async () => {
    mockPositionFindMany.mockResolvedValue([])
    await expect(
      assertCollateralNotLocked({ userId: 'user-1', protocolName: 'SOROBAN' })
    ).resolves.toBeUndefined()
    expect(mockLoanFindMany).not.toHaveBeenCalled()
  })

  it('passes when the matching positions are all unlocked', async () => {
    mockPositionFindMany.mockResolvedValue([{ id: 'pos-1' }])
    mockLoanFindMany.mockResolvedValue([])
    await expect(
      assertCollateralNotLocked({ userId: 'user-1' })
    ).resolves.toBeUndefined()
  })

  it('refuses a withdrawal that would unwind loan collateral', async () => {
    mockPositionFindMany.mockResolvedValue([{ id: 'pos-1' }])
    mockLoanFindMany.mockResolvedValue([{ positionId: 'pos-1' }])
    mockLoanFindFirst.mockResolvedValue(
      loanRow({ interestAccruedTo: HALF_YEAR })
    )

    const error = await assertCollateralNotLocked({ userId: 'user-1' }).catch(
      (e) => e
    )

    expect(error).toBeInstanceOf(AppError)
    expect(error.statusCode).toBe(409)
    // Names the loan, the amount and the way out. A bare 409 gets escalated.
    expect(error.message).toContain('locked as loan collateral')
    expect(error.message).toContain('Repay the loan')
    expect(error.details).toMatchObject({
      loanId: 'loan-1',
      positionId: 'pos-1',
    })
  })

  it('is scoped by protocol and asset, so an unrelated position still withdraws', async () => {
    // A user holding a locked XLM position and a free USDC position must be
    // able to take out the USDC. Refusing everything would make the feature
    // unusable for exactly the users who diversified around it.
    mockPositionFindMany.mockResolvedValue([{ id: 'pos-2' }])
    mockLoanFindMany.mockResolvedValue([])

    await expect(
      assertCollateralNotLocked({ userId: 'user-1', assetSymbol: 'USDC' })
    ).resolves.toBeUndefined()

    expect(mockPositionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', status: 'ACTIVE', assetSymbol: 'USDC' },
      })
    )
  })

  it('does not invent a protocol filter when none was given', async () => {
    mockPositionFindMany.mockResolvedValue([])
    await assertCollateralNotLocked({ userId: 'user-1' })
    expect(mockPositionFindMany.mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      status: 'ACTIVE',
    })
  })

  it('ignores CLOSED positions', async () => {
    // Withdrawing from a closed position must not be blocked by a loan that
    // has already been liquidated against it.
    mockPositionFindMany.mockResolvedValue([])
    await expect(
      assertCollateralNotLocked({ userId: 'user-1' })
    ).resolves.toBeUndefined()
  })

  it('releases the collateral the moment the loan stops being ACTIVE', async () => {
    // There is no flag to clear and nothing to reconcile: the guard asks the
    // same question every time, and a REPAID loan is not part of the answer.
    mockPositionFindMany.mockResolvedValue([{ id: 'pos-1' }])
    mockLoanFindMany.mockResolvedValue([])

    await expect(
      assertCollateralNotLocked({ userId: 'user-1' })
    ).resolves.toBeUndefined()
    expect(mockLoanFindMany.mock.calls[0][0].where).toMatchObject({
      status: 'ACTIVE',
    })
  })
})
