/**
 * Pure LTV / interest / liquidation math for the collateral loan book (#532).
 *
 * Zero I/O and zero Prisma: every number that decides whether a user's money
 * is force-sold is computed here, where it can be unit-tested exhaustively
 * without a database or a clock. The service layer supplies the inputs and
 * persists the outputs; this module only does arithmetic.
 *
 * ─── UNITS ─────────────────────────────────────────────────────────────────────
 * Money is a plain number in stablecoin units (18dp upstream, but every
 * figure here is a float — the service converts to/from Prisma Decimal at the
 * boundary). Rates are PERCENT, not fractions: an APY of `8` means 8%/yr,
 * matching ProtocolRate.supplyApy/borrowApy and the agent's APY conventions.
 * LTV values are FRACTIONS in [0, 1] on the way in and out, so 0.5 is 50% —
 * deliberately different from rates, because confusing the two is exactly the
 * mistake that would lend 0.5% instead of 50%.
 *
 * ─── THE RATE MODEL ────────────────────────────────────────────────────────────
 * Interest is SIMPLE (non-compounding) and charged on principal only:
 *
 *     accrued += principal * (rateApy / 100) * (elapsedMs / YEAR_MS)
 *
 * Simple interest is the same convention the agent's yield math already uses
 * (calculateApy / calculateYearsActive in src/agent/snapshotter.ts), so the
 * interest a borrower pays and the yield their collateral earns are computed
 * on one model and cannot disagree. It is also exactly re-computable from
 * (principal, rate, interestAccruedTo), which makes the accrual job
 * idempotent: running it twice in a window adds nothing the second time.
 *
 * ─── WHY THE INTEREST IS NEVER COMPOUNDED ──────────────────────────────────────
 * Compounding a borrower's debt while their collateral earns simple yield would
 * quietly make the credit line a losing proposition at high rates, and would
 * make "what do I owe" depend on the accrual job's tick history rather than on
 * a formula. A borrower's balance must be a pure function of time.
 */

export const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

/** Sums are compared with a small epsilon so float dust never reads as a breach. */
export const LTV_EPSILON = 1e-9

export interface LtvInputs {
  /** Principal + accrued interest still owed. */
  debt: number
  /** Current market value of the collateral position. */
  collateralValue: number
}

/**
 * Live loan-to-value ratio. Returns 0 for a debt-free loan, and `Infinity`
 * when collateral has gone to zero under a live debt — the caller must treat
 * that as an immediate full-liquidation, not as a ratio it can compare against
 * a threshold.
 */
export function currentLtv({ debt, collateralValue }: LtvInputs): number {
  if (!Number.isFinite(debt) || debt <= 0) return 0
  if (!Number.isFinite(collateralValue) || collateralValue <= 0) {
    return Number.POSITIVE_INFINITY
  }
  return debt / collateralValue
}

/** True when live LTV is at or above the loan's frozen liquidation threshold. */
export function isLiquidationTriggered(
  ltv: number,
  liquidationLtvThreshold: number
): boolean {
  return ltv >= liquidationLtvThreshold - LTV_EPSILON
}

/**
 * Interest accrued over [from, to] on `principal` at `rateApy` percent.
 * Never negative (a clock that moved backwards accrues nothing) and never
 * returns NaN/Infinity for a non-finite rate.
 *
 * `rateApy` is PERCENT — 8 for 8% — matching ProtocolRate.borrowApy and the
 * loan's own `interestRateApy` column. It is a division by 100, not a
 * multiplication, because a fraction (0.08) passed here would under-charge a
 * borrower 100x and the platform would quietly eat the difference. There is
 * deliberately NO "small values look like fractions, let me guess" heuristic:
 * a real 0.5% APR exists, and misreading it as 50% is a far worse failure
 * than the documented convention being wrong in one direction.
 */
export function accruedInterest(
  principal: number,
  rateApy: number,
  from: Date,
  to: Date
): number {
  if (!Number.isFinite(principal) || principal <= 0) return 0
  if (!Number.isFinite(rateApy) || rateApy <= 0) return 0

  const elapsedMs = to.getTime() - from.getTime()
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0

  return principal * (rateApy / 100) * (elapsedMs / MS_PER_YEAR)
}

/** Total owed: principal plus everything accrued to `asOf`. */
export function outstandingBalance(
  principal: number,
  interestAccrued: number,
  rateApy: number,
  interestAccruedTo: Date,
  asOf: Date
): number {
  return (
    principal +
    Math.max(0, interestAccrued) +
    accruedInterest(principal, rateApy, interestAccruedTo, asOf)
  )
}

/**
 * The borrower's charge: what the platform paid to borrow on their behalf,
 * plus the platform's documented margin. `underlyingBorrowApy` is protocol-side
 * data the scanner already records on ProtocolRate.borrowApy.
 */
export function resolveInterestRateApy(
  underlyingBorrowApy: number,
  platformSpreadApy: number
): number {
  const base = Number.isFinite(underlyingBorrowApy)
    ? Math.max(0, underlyingBorrowApy)
    : 0
  const spread = Number.isFinite(platformSpreadApy)
    ? Math.max(0, platformSpreadApy)
    : 0
  return base + spread
}

/**
 * Largest principal a position supports at `maxLtv`, plus the LTV that result
 * would carry. Clamped to zero so an unpriceable or emptied position lends
 * nothing rather than a negative or NaN amount.
 */
export function maxBorrowable(
  collateralValue: number,
  maxLtv: number
): { principal: number; ltv: number } {
  if (!Number.isFinite(collateralValue) || collateralValue <= 0) {
    return { principal: 0, ltv: 0 }
  }
  const cap = clampFraction(maxLtv)
  const principal = collateralValue * cap
  return { principal, ltv: principal / collateralValue }
}

/**
 * Reject a requested principal that is not safely under the cap.
 *
 * Compared with an epsilon slack so a client that round-trips the value through
 * a 7dp amount format is not rejected for float dust — the difference is
 * nanounits, not a risk decision.
 */
export function isWithinLtvCap(
  principal: number,
  collateralValue: number,
  maxLtv: number
): boolean {
  if (!Number.isFinite(principal) || principal <= 0) return false
  if (!Number.isFinite(collateralValue) || collateralValue <= 0) return false
  return principal <= collateralValue * clampFraction(maxLtv) + 1e-7
}

export interface LiquidationPlan {
  /** Collateral value to sell. */
  collateralToSell: number
  /** Debt the sale retires (never more than the outstanding balance). */
  debtRetired: number
  /** Debt the collateral could NOT cover — platform bad debt. */
  shortfall: number
  /** 'PARTIAL' when the sale restores a safe LTV, 'FULL' when it exhausts the position. */
  kind: 'PARTIAL' | 'FULL'
  /** LTV immediately after the sale, or null when the loan is closed out. */
  ltvAfter: number | null
  /** Live LTV before the sale. */
  ltvBefore: number
}

/**
 * Size the MINIMUM collateral sale that restores `targetLtv` on this loan.
 *
 * Selling `s` of collateral retires the debt by `min(s, debt)` and leaves
 * collateral worth `collateralValue - s`, so afterwards:
 *
 *     ltvAfter = (debt - s) / (collateralValue - s) <= targetLtv
 *
 * Solving for `s` (and only then re-deriving the result from that `s`, so the
 * reported LTV is always the real post-sale one rather than the target we
 * asked for) gives the amount below.
 *
 * When the required sale would exceed
 * `maxCollateralFractionSold` of the position, the plan escalates to the
 * maximum sale allowed and reports whatever the collateral still cannot cover
 * as `shortfall`. That is the platform absorbing the loss, and it is
 * deliberately not spread across anyone else's funds.
 *
 * A position already AT OR BETTER than the target needs no sale, so the
 * minimum is floored at zero and nothing is sold. Under a valid
 * configuration that branch is unreachable — `liquidationConfigIssues`
 * enforces `targetLtv < liquidationLtvThreshold`, and this function is only
 * ever called for a loan at or over the threshold, so the loan is necessarily
 * over the target too. It is handled explicitly anyway, because a function
 * that silently sold a user's collateral when handed an out-of-range target
 * would be a very expensive way to be wrong.
 */
export function planLiquidation(params: {
  debt: number
  collateralValue: number
  targetLtv: number
  maxCollateralFractionSold: number
}): LiquidationPlan {
  const { debt, collateralValue, targetLtv, maxCollateralFractionSold } = params
  const ltvBefore = currentLtv({ debt, collateralValue })

  const safeDebt = Number.isFinite(debt) ? Math.max(0, debt) : 0
  const safeCollateral = Number.isFinite(collateralValue)
    ? Math.max(0, collateralValue)
    : 0
  const target = clampFraction(targetLtv)
  const fractionCap = clampFraction(maxCollateralFractionSold)

  if (safeDebt <= 0) {
    return {
      collateralToSell: 0,
      debtRetired: 0,
      shortfall: 0,
      kind: 'PARTIAL',
      ltvAfter: 0,
      ltvBefore,
    }
  }

  const maxSellable = safeCollateral * fractionCap

  // The algebraic minimum, floored at zero. Only meaningful when the current
  // LTV already exceeds the target; below it, no sale improves the position.
  const denominator = 1 - target
  const required =
    denominator > LTV_EPSILON
      ? Math.max(0, (safeDebt - target * safeCollateral) / denominator)
      : Number.POSITIVE_INFINITY

  const capped = Math.min(required, maxSellable)

  const collateralToSell = Math.min(Math.max(capped, 0), safeCollateral)
  const debtRetired = Math.min(collateralToSell, safeDebt)
  const remainingCollateral = Math.max(0, safeCollateral - collateralToSell)
  const remainingDebt = Math.max(0, safeDebt - debtRetired)

  const closed = remainingDebt <= 0 || remainingCollateral <= LTV_EPSILON

  // Bad debt is recognised only when the collateral is GONE. A loan whose
  // remaining debt exceeds its remaining collateral but still holds collateral
  // is in negative equity, not yet a loss: the rest of the position can still
  // be sold (this cap applies per sale, not per loan) and booking the shortfall
  // now would overstate what the platform has actually lost.
  const shortfall = remainingCollateral <= LTV_EPSILON ? remainingDebt : 0

  const ltvAfter = closed
    ? null
    : currentLtv({ debt: remainingDebt, collateralValue: remainingCollateral })

  return {
    collateralToSell,
    debtRetired,
    shortfall,
    kind: closed ? 'FULL' : 'PARTIAL',
    ltvAfter,
    ltvBefore,
  }
}

/**
 * How much room a loan has before liquidation, as a fraction of its
 * liquidation threshold — 1 means sitting exactly on the line, 0 means
 * comfortably clear.
 *
 * Expressed as a *relative* distance so it stays meaningful when the
 * threshold itself differs per loan, and clamped to [0,1] because a loan that
 * is already past the line has no "distance left" to report; callers show that
 * as a breach, not as a negative cushion.
 */
export function liquidationDistance(
  ltv: number,
  liquidationLtvThreshold: number
): number {
  if (!Number.isFinite(ltv)) return 0
  const threshold = clampFraction(liquidationLtvThreshold)
  if (threshold <= LTV_EPSILON) return ltv <= 0 ? 1 : 0
  if (ltv >= threshold) return 0
  return Math.max(0, Math.min(1, (threshold - ltv) / threshold))
}

/**
 * Split a repayment across principal and interest, oldest-cost-first: interest
 * that has already been billed is the platform's money, so it comes off the
 * top, and whatever remains retires principal. Clamped to what is actually
 * owed so an over-payment cannot go negative and mint a credit.
 */
export function applyRepayment(params: {
  principal: number
  interestAccrued: number
  amount: number
}): {
  toInterest: number
  toPrincipal: number
  applied: number
  remainingPrincipal: number
  remainingInterest: number
  settled: boolean
} {
  const { principal, interestAccrued, amount } = params
  const totalOwed = Math.max(0, principal) + Math.max(0, interestAccrued)
  const applied = Math.min(Math.max(0, amount), totalOwed)

  const toInterest = Math.min(applied, Math.max(0, interestAccrued))
  const toPrincipal = applied - toInterest

  const remainingInterest = Math.max(0, interestAccrued - toInterest)
  const remainingPrincipal = Math.max(0, principal - toPrincipal)

  return {
    toInterest,
    toPrincipal,
    applied,
    remainingPrincipal,
    remainingInterest,
    settled: remainingPrincipal <= 0 && remainingInterest <= 0,
  }
}

/**
 * The platform's bad-debt exposure for one loan: what it is owed minus
 * everything the locked collateral can still be sold for, floored at zero.
 * This is the number docs/LENDING.md's worst-case model is stated against.
 */
export function worstCaseShortfall(
  debt: number,
  collateralValue: number
): number {
  if (!Number.isFinite(debt) || debt <= 0) return 0
  const recovery = Number.isFinite(collateralValue)
    ? Math.max(0, collateralValue)
    : 0
  return Math.max(0, debt - recovery)
}

/** Fraction in [0,1]; a non-finite input falls back to `fallback`. */
function clampFraction(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}
