/**
 * Pure lending arithmetic (#532).
 *
 * This file is the executable form of the safety argument in
 * src/lending/risk.ts. It has no mocks and no database on purpose: every
 * number that decides whether a user keeps their collateral or loses it is
 * computed by these functions, and the point of isolating them is that they
 * can be pushed to their boundaries without standing up a stack.
 *
 * The cases that matter most are the degenerate ones — zero collateral, a
 * target LTV above the threshold, a clock that runs backwards — because those
 * are where a lending book normally loses money quietly.
 */

import {
  MS_PER_YEAR,
  accruedInterest,
  applyRepayment,
  outstandingBalanceExact,
  MoneyDecimal,
  currentLtv,
  isLiquidationTriggered,
  isWithinLtvCap,
  liquidationDistance,
  maxBorrowable,
  outstandingBalance,
  planLiquidation,
  resolveInterestRateApy,
  worstCaseShortfall,
} from '../../../src/lending/risk'
import { Prisma } from '@prisma/client'

const NOW = new Date('2026-06-01T00:00:00.000Z')
const YEAR_AGO = new Date(NOW.getTime() - MS_PER_YEAR)

describe('src/lending/risk — currentLtv', () => {
  it('is 0 for a debt-free loan regardless of collateral', () => {
    expect(currentLtv({ debt: 0, collateralValue: 10_000 })).toBe(0)
    expect(currentLtv({ debt: -5, collateralValue: 10_000 })).toBe(0)
  })

  it('is Infinity when collateral is gone but debt remains', () => {
    // Must NOT be 0 or NaN: the caller compares this against the threshold,
    // and anything finite would let a wiped-out position look healthy.
    expect(currentLtv({ debt: 100, collateralValue: 0 })).toBe(
      Number.POSITIVE_INFINITY
    )
    expect(currentLtv({ debt: 100, collateralValue: -3 })).toBe(
      Number.POSITIVE_INFINITY
    )
  })

  it('is the plain ratio in the normal case', () => {
    expect(currentLtv({ debt: 5_000, collateralValue: 10_000 })).toBeCloseTo(
      0.5,
      12
    )
    expect(currentLtv({ debt: 7_500, collateralValue: 10_000 })).toBeCloseTo(
      0.75,
      12
    )
  })
})

describe('src/lending/risk — isLiquidationTriggered', () => {
  it('fires at the threshold exactly, not only past it', () => {
    expect(isLiquidationTriggered(0.75, 0.75)).toBe(true)
  })

  it('does not fire below the threshold', () => {
    expect(isLiquidationTriggered(0.7499, 0.75)).toBe(false)
  })

  it('fires for an infinite LTV (wiped-out collateral)', () => {
    expect(isLiquidationTriggered(Number.POSITIVE_INFINITY, 0.75)).toBe(true)
  })
})

describe('src/lending/risk — accruedInterest', () => {
  it('charges exactly rate% of principal over a full year', () => {
    expect(accruedInterest(10_000, 8, YEAR_AGO, NOW)).toBeCloseTo(800, 6)
  })

  it('is simple interest, not compounding: two half-years equal one year', () => {
    const half = MS_PER_YEAR / 2
    const first = accruedInterest(
      10_000,
      12,
      NOW,
      new Date(NOW.getTime() + half)
    )
    const second = accruedInterest(
      10_000,
      12,
      new Date(NOW.getTime() + half),
      new Date(NOW.getTime() + half * 2)
    )
    expect(first + second).toBeCloseTo(1_200, 6)
  })

  it('is a pure function of elapsed time, so a missed tick is not lost interest', () => {
    // 10 days in one step must equal 10 days taken in 240 hourly steps: this
    // is the property that makes a stalled accrual job harmless.
    const tenDays = 10 * 24 * 60 * 60 * 1000
    const oneStep = accruedInterest(
      10_000,
      9,
      NOW,
      new Date(NOW.getTime() + tenDays)
    )

    let stepped = 0
    for (let h = 1; h <= 240; h++) {
      stepped += accruedInterest(
        10_000,
        9,
        new Date(NOW.getTime() + (h - 1) * 60 * 60 * 1000),
        new Date(NOW.getTime() + h * 60 * 60 * 1000)
      )
    }
    expect(stepped).toBeCloseTo(oneStep, 4)
  })

  it('charges nothing for a backwards or zero-length window', () => {
    expect(accruedInterest(10_000, 8, NOW, YEAR_AGO)).toBe(0)
    expect(accruedInterest(10_000, 8, NOW, NOW)).toBe(0)
  })

  it('charges nothing for a zero principal or a non-finite rate', () => {
    expect(accruedInterest(0, 8, YEAR_AGO, NOW)).toBe(0)
    expect(accruedInterest(10_000, Number.NaN, YEAR_AGO, NOW)).toBe(0)
    expect(accruedInterest(10_000, 0, YEAR_AGO, NOW)).toBe(0)
  })
})

describe('src/lending/risk — outstandingBalance', () => {
  it('is principal plus billed interest plus unbilled accrual', () => {
    const balance = outstandingBalance(1_000, 20, 10, YEAR_AGO, NOW)
    expect(balance).toBeCloseTo(1_000 + 20 + 100, 6)
  })

  it('never reports less than the principal', () => {
    const balance = outstandingBalance(1_000, 0, 0, NOW, NOW)
    expect(balance).toBe(1_000)
  })
})

describe('src/lending/risk — resolveInterestRateApy', () => {
  it('adds the platform spread on top of the underlying borrow rate', () => {
    expect(resolveInterestRateApy(8, 3)).toBe(11)
  })

  it('treats a missing or negative rate as zero rather than producing a discount', () => {
    expect(resolveInterestRateApy(Number.NaN, 3)).toBe(3)
    expect(resolveInterestRateApy(-4, 3)).toBe(3)
  })
})

describe('src/lending/risk — maxBorrowable / isWithinLtvCap', () => {
  it('caps principal at the configured LTV', () => {
    const cap = maxBorrowable(10_000, 0.5)
    expect(cap.principal).toBeCloseTo(5_000, 9)
    expect(cap.ltv).toBeCloseTo(0.5, 12)
  })

  it('lends nothing against an unvaluable position instead of NaN', () => {
    expect(maxBorrowable(0, 0.5).principal).toBe(0)
    expect(maxBorrowable(Number.NaN, 0.5).principal).toBe(0)
  })

  it('accepts a request exactly at the cap and rejects one token above it', () => {
    expect(isWithinLtvCap(5_000, 10_000, 0.5)).toBe(true)
    expect(isWithinLtvCap(5_000.01, 10_000, 0.5)).toBe(false)
  })

  it('tolerates 7dp round-tripping through an amount format', () => {
    // A client formatting 1234.5678901 for the wire must not be rejected for
    // float dust; a real risk breach is orders of magnitude larger.
    expect(isWithinLtvCap(1234.5678901, 2469.1357802, 0.5)).toBe(true)
  })

  it('rejects a non-positive request', () => {
    expect(isWithinLtvCap(0, 10_000, 0.5)).toBe(false)
    expect(isWithinLtvCap(-100, 10_000, 0.5)).toBe(false)
  })
})

describe('src/lending/risk — planLiquidation', () => {
  const base = {
    debt: 8_000,
    collateralValue: 10_000,
    targetLtv: 0.6,
    maxCollateralFractionSold: 1,
  }

  it('sells the MINIMUM collateral that restores the target LTV', () => {
    // Solve (8000 - s) / (10000 - s) = 0.6  ->  s = 5000.
    // Note this is NOT 2000: selling 2000 only brings LTV to 0.75, the
    // threshold, which is where the loan already sits. Selling less than the
    // target requires is the single most common way a liquidation leaves a
    // loan still in breach, and the monitor would then re-liquidate it every
    // tick forever.
    const plan = planLiquidation(base)
    expect(plan.collateralToSell).toBeCloseTo(5_000, 6)
    expect(plan.debtRetired).toBeCloseTo(5_000, 6)
    expect(plan.shortfall).toBe(0)
    expect(plan.kind).toBe('PARTIAL')
    expect(plan.ltvBefore).toBeCloseTo(0.8, 12)
    expect(plan.ltvAfter).toBeCloseTo(0.6, 9)
  })

  it('reports the real post-sale LTV rather than the target it asked for', () => {
    const plan = planLiquidation({ ...base, debt: 8_100 })
    const recomputed =
      (8_100 - plan.collateralToSell) / (10_000 - plan.collateralToSell)
    expect(plan.ltvAfter).toBeCloseTo(recomputed, 9)
  })

  it('books the uncovered remainder as shortfall rather than selling past the collateral', () => {
    // Collateral worth 1,000 against 8,000 of debt: the sale can recover 1,000
    // and the platform is out 7,000. It must never claim to have sold more
    // collateral than exists.
    const plan = planLiquidation({
      debt: 8_000,
      collateralValue: 1_000,
      targetLtv: 0.6,
      maxCollateralFractionSold: 1,
    })
    expect(plan.collateralToSell).toBeCloseTo(1_000, 6)
    expect(plan.debtRetired).toBeCloseTo(1_000, 6)
    expect(plan.shortfall).toBeCloseTo(7_000, 6)
    expect(plan.kind).toBe('FULL')
    expect(plan.ltvAfter).toBeNull()
    // LTV is finite but catastrophic (8x), not Infinity — the collateral is
    // small, not gone.
    expect(plan.ltvBefore).toBeCloseTo(8, 12)
  })

  it('sells nothing when the position is already better than the target', () => {
    // Unreachable under a valid config (the config guard enforces
    // targetLtv < liquidationLtvThreshold, and this is only called for a loan
    // at or over that threshold). Handled explicitly because a misconfigured
    // target must not trigger the arbitrary destruction of collateral that is
    // already at a safe ratio.
    const plan = planLiquidation({
      debt: 8_000,
      collateralValue: 10_000,
      targetLtv: 0.9,
      maxCollateralFractionSold: 1,
    })
    expect(plan.collateralToSell).toBe(0)
    expect(plan.debtRetired).toBe(0)
    expect(plan.shortfall).toBe(0)
    expect(plan.ltvAfter).toBeCloseTo(0.8, 12)
  })

  it('caps the sale at maxCollateralFractionSold without writing off coverable debt', () => {
    // Selling 10% (1,000) leaves 9,000 of collateral against 7,000 of debt.
    // That is still fully covered, so the remaining debt is NOT bad debt — the
    // cap applies per sale, and the next tick can sell more.
    const plan = planLiquidation({
      debt: 8_000,
      collateralValue: 10_000,
      targetLtv: 0.6,
      maxCollateralFractionSold: 0.1,
    })
    expect(plan.collateralToSell).toBeCloseTo(1_000, 6)
    expect(plan.debtRetired).toBeCloseTo(1_000, 6)
    expect(plan.shortfall).toBe(0)
    expect(plan.kind).toBe('PARTIAL')
    expect(plan.ltvAfter).toBeCloseTo(7_000 / 9_000, 9)
  })

  it('does nothing for a loan with no debt', () => {
    const plan = planLiquidation({ ...base, debt: 0 })
    expect(plan.collateralToSell).toBe(0)
    expect(plan.shortfall).toBe(0)
    expect(plan.ltvAfter).toBe(0)
  })

  it('closes out a zero-collateral loan as pure bad debt', () => {
    const plan = planLiquidation({ ...base, collateralValue: 0 })
    expect(plan.collateralToSell).toBe(0)
    expect(plan.debtRetired).toBe(0)
    expect(plan.shortfall).toBe(8_000)
    expect(plan.kind).toBe('FULL')
    expect(plan.ltvAfter).toBeNull()
  })

  it('clamps a nonsensical maxCollateralFractionSold instead of trusting it', () => {
    const plan = planLiquidation({ ...base, maxCollateralFractionSold: 5 })
    expect(plan.collateralToSell).toBeCloseTo(5_000, 6)
  })
})

describe('src/lending/risk — liquidationDistance', () => {
  it('is 1 when sitting exactly on the line and 0 once past it', () => {
    expect(liquidationDistance(0.75, 0.75)).toBe(0)
    expect(liquidationDistance(0.9, 0.75)).toBe(0)
  })

  it('is the relative distance below the threshold, clamped to [0,1]', () => {
    // 0.375 of 0.75 => half the threshold left.
    expect(liquidationDistance(0.375, 0.75)).toBeCloseTo(0.5, 12)
    expect(liquidationDistance(0, 0.75)).toBe(1)
  })

  it('is 0 for an infinite LTV rather than NaN', () => {
    expect(liquidationDistance(Number.POSITIVE_INFINITY, 0.75)).toBe(0)
  })
})

describe('src/lending/risk — applyRepayment', () => {
  it('takes interest first, then principal', () => {
    const split = applyRepayment({
      principal: 1_000,
      interestAccrued: 50,
      amount: 30,
    })
    expect(split.toInterest.toString()).toBe('30')
    expect(split.toPrincipal.toString()).toBe('0')
    expect(split.remainingInterest.toString()).toBe('20')
    expect(split.remainingPrincipal.toString()).toBe('1000')
    expect(split.settled).toBe(false)
  })

  it('spills into principal once interest is cleared', () => {
    const split = applyRepayment({
      principal: 1_000,
      interestAccrued: 20,
      amount: 320,
    })
    expect(split.toInterest.toString()).toBe('20')
    expect(split.toPrincipal.toString()).toBe('300')
    expect(split.remainingPrincipal.toString()).toBe('700')
  })

  it('settles on an exact payoff', () => {
    const split = applyRepayment({
      principal: 1_000,
      interestAccrued: 20,
      amount: 1_020,
    })
    expect(split.settled).toBe(true)
    expect(split.remainingPrincipal.isZero()).toBe(true)
    expect(split.remainingInterest.isZero()).toBe(true)
  })

  it('never credits more than is owed on an overpayment', () => {
    // A user who overpays must not acquire a negative balance, which would
    // silently become borrowing power on the next origination.
    const split = applyRepayment({
      principal: 1_000,
      interestAccrued: 20,
      amount: 5_000,
    })
    expect(split.applied.toString()).toBe('1020')
    expect(split.remainingPrincipal.isZero()).toBe(true)
    expect(split.remainingInterest.isZero()).toBe(true)
  })

  it('treats a zero or negative amount as a no-op', () => {
    const split = applyRepayment({
      principal: 1_000,
      interestAccrued: 20,
      amount: -5,
    })
    expect(split.applied.isZero()).toBe(true)
    expect(split.remainingPrincipal.toString()).toBe('1000')
  })

  // #662 — feed each split's remainders into the next repayment, the way
  // applyConfirmedRepayment persists and re-reads them.
  function repayInParts(
    start: { principal: string; interestAccrued: string },
    amounts: string[]
  ) {
    let principal: Prisma.Decimal.Value = start.principal
    let interestAccrued: Prisma.Decimal.Value = start.interestAccrued
    let split = applyRepayment({ principal, interestAccrued, amount: 0 })
    for (const amount of amounts) {
      split = applyRepayment({ principal, interestAccrued, amount })
      principal = split.remainingPrincipal
      interestAccrued = split.remainingInterest
    }
    return split
  }

  it('settles exactly after ten 0.1 repayments on a 1.0 loan (float leaves 1.4e-16 dust)', () => {
    // Float arithmetic: 1 - 0.1 x 10 = 1.3877787807814457e-16, which kept
    // the loan ACTIVE with dust under the previous implementation.
    let floatRemaining = 1
    for (let i = 0; i < 10; i++) floatRemaining -= 0.1
    expect(floatRemaining).toBeGreaterThan(0)

    const split = repayInParts(
      { principal: '1', interestAccrued: '0' },
      Array(10).fill('0.1')
    )
    expect(split.settled).toBe(true)
    expect(split.remainingPrincipal.toString()).toBe('0')
  })

  it('does not settle when a single base unit (1e-18) is still owed', () => {
    const split = repayInParts(
      { principal: '1', interestAccrued: '0.000000000000000001' },
      Array(10).fill('0.1')
    )
    // Under the old 1e-9 epsilon this read as settled while debt remained.
    // Interest is paid first, so the last base unit is left on principal.
    expect(split.settled).toBe(false)
    expect(split.remainingInterest.isZero()).toBe(true)
    expect(split.remainingPrincipal.toString()).toBe('1e-18')
  })

  it('keeps full 18dp precision on large balances across partial repayments', () => {
    const split = repayInParts(
      {
        principal: '123456789.123456789123456789',
        interestAccrued: '0.333333333333333333',
      },
      ['0.333333333333333333', '23456789.123456789123456789', '0.1']
    )
    expect(split.remainingInterest.isZero()).toBe(true)
    expect(split.remainingPrincipal.toFixed(18)).toBe(
      '99999999.900000000000000000'
    )
    expect(split.settled).toBe(false)

    const final = repayInParts(
      {
        principal: split.remainingPrincipal.toString(),
        interestAccrued: '0',
      },
      ['99999999.9']
    )
    expect(final.settled).toBe(true)
  })

  it('conserves value: every repayment lands in exactly one bucket', () => {
    const start = {
      principal: '1000.123456789012345678',
      interestAccrued: '7.777777777777777777',
    }
    const amounts = ['3.3', '0.000000000000000007', '250.25', '0.1', '0.2']
    let principal: Prisma.Decimal.Value = start.principal
    let interestAccrued: Prisma.Decimal.Value = start.interestAccrued
    let paid = new MoneyDecimal(0)
    for (const amount of amounts) {
      const split = applyRepayment({ principal, interestAccrued, amount })
      expect(split.toInterest.plus(split.toPrincipal).eq(split.applied)).toBe(
        true
      )
      paid = paid.plus(split.applied)
      principal = split.remainingPrincipal
      interestAccrued = split.remainingInterest
    }
    const owedBefore = new MoneyDecimal(start.principal).plus(
      start.interestAccrued
    )
    const owedAfter = new MoneyDecimal(principal).plus(interestAccrued)
    expect(owedBefore.minus(owedAfter).eq(paid)).toBe(true)
  })
})

describe('src/lending/risk — outstandingBalanceExact', () => {
  it('matches the float form and settles a payoff of exactly that amount', () => {
    const exact = outstandingBalanceExact('1000', '20', '10', YEAR_AGO, NOW)
    expect(exact.toNumber()).toBeCloseTo(
      outstandingBalance(1_000, 20, 10, YEAR_AGO, NOW),
      9
    )
    const split = applyRepayment({
      principal: '1000',
      interestAccrued: exact.minus(1000),
      amount: exact,
    })
    expect(split.settled).toBe(true)
  })
})

describe('src/lending/risk — worstCaseShortfall', () => {
  it('is the uncovered part of the debt', () => {
    expect(worstCaseShortfall(8_000, 5_000)).toBe(3_000)
    expect(worstCaseShortfall(5_000, 8_000)).toBe(0)
    expect(worstCaseShortfall(5_000, 0)).toBe(5_000)
    expect(worstCaseShortfall(0, 0)).toBe(0)
  })
})
