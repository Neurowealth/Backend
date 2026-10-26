/**
 * Goal-linked auto-contributions with catch-up sizing (#357).
 *
 * Pure, deterministic sizing engine that computes the next recurring deposit
 * contribution from the gap between a `SavingsGoal`'s projected trajectory and
 * its `targetAmount`, bounded by `[minAmount, maxAmount]`.
 *
 * Trajectory math uses the same simple (non-compounding) APY convention as
 * `src/goals/service.ts` and `src/agent/strategies.ts`:
 *   projectedFromCurrent = currentAmount * (1 + (actualApy / 100) * yearsRemaining)
 *   scheduledContributions = remainingRuns * baseAmount
 *   projectedValue = projectedFromCurrent + scheduledContributions
 *   shortfall = targetAmount - projectedValue
 *
 * Horizons:
 *   - `NEXT_RUN`: next contribution = `baseAmount + shortfall`
 *   - `SPREAD_REMAINING`: next contribution = `baseAmount + shortfall / remainingRuns`
 *
 * Ahead of target (`shortfall < 0`):
 *   - Reduces contribution toward `minAmount` (never below).
 *   - When `minAmount` is unset, floors at `DEFAULT_AHEAD_FLOOR_FRACTION` (25%)
 *     of `baseAmount` so the plan never drops to 0 or negative.
 */

import { Prisma } from '@prisma/client'
import { addCadence } from '../utils/cadence'
import { calculateYearsRemaining } from '../agent/strategies'

export type GoalSizingMode = 'FIXED' | 'GOAL_CATCH_UP'
export type CatchUpHorizon = 'NEXT_RUN' | 'SPREAD_REMAINING'
export type ClampedBy = 'min' | 'max' | null
export type DepositCadenceType = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'

/**
 * Documented floor fraction of `baseAmount` when a goal is ahead of target
 * (`shortfall < 0`) and no explicit `minAmount` bound is configured.
 */
export const DEFAULT_AHEAD_FLOOR_FRACTION = 0.25

const DEFAULT_SCALE = 8
const ZERO = new Prisma.Decimal(0)

export interface GoalTargetSpec {
  targetAmount: number | string | Prisma.Decimal
  targetDate: Date | string
  startingAmount?: number | string | Prisma.Decimal
  riskCeiling?: number | null
  baseAmount?: number | string | Prisma.Decimal
}

export interface ContributionBounds {
  minAmount?: number | string | Prisma.Decimal | null
  maxAmount?: number | string | Prisma.Decimal | null
  baseAmount?: number | string | Prisma.Decimal
  horizon?: CatchUpHorizon
  precision?: number
}

export interface ComputeGoalContributionInput {
  goal: GoalTargetSpec
  currentAmount: number | string | Prisma.Decimal
  actualApy?: number | null
  fallbackApy?: number | null
  cadence: DepositCadenceType
  now?: Date
  mode?: GoalSizingMode
  horizon?: CatchUpHorizon
  baseAmount?: number | string | Prisma.Decimal
  bounds?: ContributionBounds
}

export interface GoalProjectionBasis {
  currentAmount: number
  targetAmount: number
  baseAmount: number
  effectiveApy: number
  apySource: 'actual' | 'risk_ceiling_fallback' | 'zero_fallback'
  yearsRemaining: number
  remainingRuns: number
  horizon: CatchUpHorizon
  projectedFromCurrent: number
  scheduledContributions: number
  projectedValue: number
  aheadFloorFraction: number
  effectiveMinAmount: number | null
  effectiveMaxAmount: number | null
  caveat: string | null
}

export interface GoalContributionSizingResult {
  amount: number
  decimalAmount: string
  shortfall: number
  decimalShortfall: string
  unclampedAmount: number
  clampedBy: ClampedBy
  remainingRuns: number
  projectedValue: number
  onTrackAfterRun: boolean
  stillShortAfterRun: boolean
  projectionBasis: GoalProjectionBasis
}

export interface BalanceFallbackResult {
  action: 'FULL' | 'PARTIAL' | 'SKIP'
  appliedAmount: number
  lastRunStatus:
    'executed' | 'executed_partial_balance' | 'skipped_insufficient_balance'
  reason: string
}

export interface GoalCatchUpPreviewRun {
  runNumber: number
  scheduledDate: string
  baseAmount: number
  projectedCurrentAmountBeforeRun: number
  shortfallBeforeRun: number
  unclampedAmount: number
  appliedAmount: number
  clampedBy: ClampedBy
  remainingRuns: number
  projectedGoalValueAtTarget: number
  onTrackAfterRun: boolean
}

export interface GoalCatchUpPreviewResult {
  planId: string
  goalId: string
  sizingMode: GoalSizingMode
  horizon: CatchUpHorizon
  runsCount: number
  totalProjectedContribution: number
  runs: GoalCatchUpPreviewRun[]
  onTrackWithCurrentBounds: boolean
  estimatedCompletionDate: string | null
  daysLate: number
  completionSummary: string
  projectionBasis: GoalProjectionBasis
  disclaimer: string
  isSimulation: true
}

export interface PreviewGoalCatchUpInput {
  planId: string
  goalId: string
  goal: GoalTargetSpec
  currentAmount: number | string | Prisma.Decimal
  actualApy?: number | null
  fallbackApy?: number | null
  cadence: DepositCadenceType
  baseAmount: number | string | Prisma.Decimal
  sizingMode?: GoalSizingMode
  horizon?: CatchUpHorizon
  bounds?: ContributionBounds
  runs?: number
  now?: Date
}

function toDec(
  value: number | string | Prisma.Decimal | undefined | null
): Prisma.Decimal {
  if (value === undefined || value === null) return ZERO
  if (value instanceof Prisma.Decimal) return value
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ZERO
  return new Prisma.Decimal(String(value))
}

function roundDec(
  value: Prisma.Decimal,
  scale: number = DEFAULT_SCALE
): Prisma.Decimal {
  return value.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP)
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value)
}

function cadenceDaysApprox(cadence: DepositCadenceType): number {
  switch (cadence) {
    case 'WEEKLY':
      return 7
    case 'BIWEEKLY':
      return 14
    case 'MONTHLY':
      return 30.4375
  }
}

/**
 * Count how many scheduled cadence runs occur from `now` through `targetDate`
 * (inclusive of the current run at `now` when `now <= targetDate`).
 * Always returns at least 1 so division by `remainingRuns` is well-defined
 * even when a goal is at or past its deadline.
 */
export function countRemainingRuns(
  now: Date,
  targetDate: Date,
  cadence: DepositCadenceType
): number {
  if (targetDate.getTime() <= now.getTime()) {
    return 1
  }
  let count = 1 // Current due run at `now`
  let cursor = addCadence(cadence, now)
  const maxIterations = 2600 // 50 years of weekly runs cap
  while (cursor.getTime() <= targetDate.getTime() && count < maxIterations) {
    count++
    cursor = addCadence(cadence, cursor)
  }
  return Math.max(1, count)
}

/**
 * Pure catch-up contribution sizing function (#357).
 */
export function computeContribution(
  input: ComputeGoalContributionInput
): GoalContributionSizingResult {
  const now = input.now ?? new Date()
  const targetDate = toDate(input.goal.targetDate)
  const scale = input.bounds?.precision ?? DEFAULT_SCALE
  const mode: GoalSizingMode = input.mode ?? 'GOAL_CATCH_UP'
  const horizon: CatchUpHorizon =
    input.horizon ?? input.bounds?.horizon ?? 'SPREAD_REMAINING'

  const targetAmountDec = Prisma.Decimal.max(
    ZERO,
    toDec(input.goal.targetAmount)
  )
  const currentAmountDec = Prisma.Decimal.max(ZERO, toDec(input.currentAmount))
  const baseAmountRaw =
    input.baseAmount ?? input.bounds?.baseAmount ?? input.goal.baseAmount ?? 0
  const baseAmountDec = Prisma.Decimal.max(ZERO, toDec(baseAmountRaw))

  // Resolve effective APY and document basis/caveat when actualApy is unavailable
  let effectiveApy = 0
  let apySource: GoalProjectionBasis['apySource'] = 'zero_fallback'
  let caveat: string | null =
    'actualApy unavailable; projecting with 0% APY (contributions only).'

  if (
    typeof input.actualApy === 'number' &&
    Number.isFinite(input.actualApy) &&
    input.actualApy > 0
  ) {
    effectiveApy = input.actualApy
    apySource = 'actual'
    caveat = null
  } else if (
    typeof input.fallbackApy === 'number' &&
    Number.isFinite(input.fallbackApy) &&
    input.fallbackApy > 0
  ) {
    effectiveApy = input.fallbackApy
    apySource = 'risk_ceiling_fallback'
    caveat =
      'No active position APY available; using riskCeiling-eligible protocol APY as optimistic bound.'
  }

  const yearsRemaining = Math.max(0, calculateYearsRemaining(targetDate, now))
  const remainingRuns = countRemainingRuns(now, targetDate, input.cadence)

  // Non-compounding projection: currentAmount * (1 + (apy / 100) * yearsRemaining)
  const growthMultiplier = new Prisma.Decimal(1).plus(
    new Prisma.Decimal(String(effectiveApy))
      .div(100)
      .mul(new Prisma.Decimal(String(yearsRemaining)))
  )
  const projectedFromCurrentDec = roundDec(
    currentAmountDec.mul(growthMultiplier),
    scale
  )
  const scheduledContributionsDec = roundDec(
    baseAmountDec.mul(remainingRuns),
    scale
  )
  const projectedValueDec = roundDec(
    projectedFromCurrentDec.plus(scheduledContributionsDec),
    scale
  )
  const shortfallDec = roundDec(targetAmountDec.minus(projectedValueDec), scale)

  const hasMinBound =
    input.bounds?.minAmount !== undefined && input.bounds?.minAmount !== null
  const hasMaxBound =
    input.bounds?.maxAmount !== undefined && input.bounds?.maxAmount !== null
  const minBoundDec = hasMinBound
    ? roundDec(Prisma.Decimal.max(ZERO, toDec(input.bounds!.minAmount)), scale)
    : null
  const maxBoundDec = hasMaxBound
    ? roundDec(Prisma.Decimal.max(ZERO, toDec(input.bounds!.maxAmount)), scale)
    : null

  if (mode === 'FIXED') {
    let fixedDec = roundDec(baseAmountDec, scale)
    let clampedBy: ClampedBy = null
    if (minBoundDec && fixedDec.lt(minBoundDec)) {
      fixedDec = minBoundDec
      clampedBy = 'min'
    } else if (maxBoundDec && fixedDec.gt(maxBoundDec)) {
      fixedDec = maxBoundDec
      clampedBy = 'max'
    }

    const deltaFromBase = fixedDec.minus(baseAmountDec)
    const afterRunProjected = projectedValueDec.plus(deltaFromBase)
    const stillShort = afterRunProjected.lt(targetAmountDec)

    return {
      amount: Number(fixedDec),
      decimalAmount: fixedDec.toString(),
      shortfall: Number(shortfallDec),
      decimalShortfall: shortfallDec.toString(),
      unclampedAmount: Number(baseAmountDec),
      clampedBy,
      remainingRuns,
      projectedValue: Number(projectedValueDec),
      onTrackAfterRun: !stillShort,
      stillShortAfterRun: stillShort,
      projectionBasis: {
        currentAmount: Number(currentAmountDec),
        targetAmount: Number(targetAmountDec),
        baseAmount: Number(baseAmountDec),
        effectiveApy,
        apySource,
        yearsRemaining,
        remainingRuns,
        horizon,
        projectedFromCurrent: Number(projectedFromCurrentDec),
        scheduledContributions: Number(scheduledContributionsDec),
        projectedValue: Number(projectedValueDec),
        aheadFloorFraction: DEFAULT_AHEAD_FLOOR_FRACTION,
        effectiveMinAmount: minBoundDec ? Number(minBoundDec) : null,
        effectiveMaxAmount: maxBoundDec ? Number(maxBoundDec) : null,
        caveat,
      },
    }
  }

  // GOAL_CATCH_UP mode:
  // Compute adjustment relative to baseAmount
  const adjustmentDec =
    horizon === 'NEXT_RUN' ? shortfallDec : shortfallDec.div(remainingRuns)
  const rawUnclampedDec = roundDec(baseAmountDec.plus(adjustmentDec), scale)

  // Determine effective lower floor:
  // When ahead of target (shortfall < 0) and minAmount is unset, floor at
  // DEFAULT_AHEAD_FLOOR_FRACTION * baseAmount so contribution never drops to 0.
  const aheadDefaultFloorDec = roundDec(
    baseAmountDec.mul(new Prisma.Decimal(String(DEFAULT_AHEAD_FLOOR_FRACTION))),
    scale
  )
  const effectiveMinDec =
    minBoundDec !== null
      ? minBoundDec
      : shortfallDec.lt(ZERO)
        ? aheadDefaultFloorDec
        : ZERO

  let appliedDec = rawUnclampedDec
  let clampedBy: ClampedBy = null

  if (appliedDec.lt(effectiveMinDec)) {
    appliedDec = effectiveMinDec
    if (minBoundDec !== null || shortfallDec.lt(ZERO)) {
      clampedBy = 'min'
    }
  }
  if (maxBoundDec !== null && appliedDec.gt(maxBoundDec)) {
    appliedDec = maxBoundDec
    clampedBy = 'max'
  }

  appliedDec = roundDec(Prisma.Decimal.max(ZERO, appliedDec), scale)

  // Check if the goal remains short after applying this run (and assuming
  // remaining future runs also contribute up to appliedDec in SPREAD_REMAINING
  // or baseAmount in NEXT_RUN)
  const projectedTotalContributionsAfterClamp =
    horizon === 'NEXT_RUN'
      ? appliedDec.plus(baseAmountDec.mul(Math.max(0, remainingRuns - 1)))
      : appliedDec.mul(remainingRuns)
  const projectedFinalWithClamp = roundDec(
    projectedFromCurrentDec.plus(projectedTotalContributionsAfterClamp),
    scale
  )
  const stillShortAfterRun = projectedFinalWithClamp.lt(
    targetAmountDec.minus(new Prisma.Decimal('0.000001'))
  )

  return {
    amount: Number(appliedDec),
    decimalAmount: appliedDec.toString(),
    shortfall: Number(shortfallDec),
    decimalShortfall: shortfallDec.toString(),
    unclampedAmount: Number(rawUnclampedDec),
    clampedBy,
    remainingRuns,
    projectedValue: Number(projectedValueDec),
    onTrackAfterRun: !stillShortAfterRun,
    stillShortAfterRun,
    projectionBasis: {
      currentAmount: Number(currentAmountDec),
      targetAmount: Number(targetAmountDec),
      baseAmount: Number(baseAmountDec),
      effectiveApy,
      apySource,
      yearsRemaining,
      remainingRuns,
      horizon,
      projectedFromCurrent: Number(projectedFromCurrentDec),
      scheduledContributions: Number(scheduledContributionsDec),
      projectedValue: Number(projectedValueDec),
      aheadFloorFraction: DEFAULT_AHEAD_FLOOR_FRACTION,
      effectiveMinAmount: Number(effectiveMinDec),
      effectiveMaxAmount: maxBoundDec ? Number(maxBoundDec) : null,
      caveat,
    },
  }
}

/**
 * Evaluate available user balance against the derived contribution amount.
 *
 * - If `availableBalance >= derivedAmount`: deposit full `derivedAmount`.
 * - If `minFloor <= availableBalance < derivedAmount`: degrade gracefully to
 *   `availableBalance` (`PARTIAL`).
 * - If `availableBalance < minFloor` (or `<= 0`): skip run with
 *   `lastRunStatus = 'skipped_insufficient_balance'` — never attempt an
 *   on-chain transaction that will fail.
 */
export function evaluateBalanceFallback(params: {
  derivedAmount: number
  availableBalance: number
  minAmount?: number | null
}): BalanceFallbackResult {
  const derived = Number(params.derivedAmount)
  const available = Number(params.availableBalance)
  const minFloor =
    params.minAmount !== undefined &&
    params.minAmount !== null &&
    params.minAmount > 0
      ? Number(params.minAmount)
      : Number(
          roundDec(
            toDec(derived).mul(
              new Prisma.Decimal(String(DEFAULT_AHEAD_FLOOR_FRACTION))
            )
          )
        )

  if (!Number.isFinite(available) || available < minFloor || available <= 0) {
    return {
      action: 'SKIP',
      appliedAmount: 0,
      lastRunStatus: 'skipped_insufficient_balance',
      reason: `Available balance (${Math.max(0, available).toFixed(2)}) is below minimum required contribution (${minFloor.toFixed(2)})`,
    }
  }

  if (available < derived) {
    const partial = Number(roundDec(toDec(available)))
    return {
      action: 'PARTIAL',
      appliedAmount: partial,
      lastRunStatus: 'executed_partial_balance',
      reason: `Available balance (${partial.toFixed(2)}) is below derived catch-up amount (${derived.toFixed(2)}); depositing available balance down to minAmount`,
    }
  }

  return {
    action: 'FULL',
    appliedAmount: derived,
    lastRunStatus: 'executed',
    reason: 'Full derived catch-up contribution covered by available balance',
  }
}

/**
 * Deterministically preview the next `N` runs of a goal-linked recurring deposit
 * plan, including whether `maxAmount` bounds delay goal completion (#357).
 */
export function previewGoalCatchUpRuns(
  input: PreviewGoalCatchUpInput
): GoalCatchUpPreviewResult {
  const now = input.now ?? new Date()
  const targetDate = toDate(input.goal.targetDate)
  const numRuns = Math.max(1, Math.min(52, input.runs ?? 12))
  const mode: GoalSizingMode = input.sizingMode ?? 'GOAL_CATCH_UP'
  const horizon: CatchUpHorizon =
    input.horizon ?? input.bounds?.horizon ?? 'SPREAD_REMAINING'
  const baseAmount = Number(toDec(input.baseAmount))

  const initialSizing = computeContribution({
    goal: input.goal,
    currentAmount: input.currentAmount,
    actualApy: input.actualApy,
    fallbackApy: input.fallbackApy,
    cadence: input.cadence,
    now,
    mode,
    horizon,
    baseAmount,
    bounds: input.bounds,
  })

  const effectiveApy = initialSizing.projectionBasis.effectiveApy
  const stepYears = cadenceDaysApprox(input.cadence) / 365.25

  const runs: GoalCatchUpPreviewRun[] = []
  let simulatedCurrent = Number(toDec(input.currentAmount))
  let totalProjectedContribution = 0
  let runDate = addCadence(input.cadence, now)

  for (let i = 0; i < numRuns; i++) {
    // Yield accrued over the cadence interval before this run
    const stepYield = simulatedCurrent * (effectiveApy / 100) * stepYears
    const balanceBeforeRun = Number(
      roundDec(toDec(simulatedCurrent + stepYield))
    )

    const stepDecision = computeContribution({
      goal: input.goal,
      currentAmount: balanceBeforeRun,
      actualApy: input.actualApy,
      fallbackApy: input.fallbackApy,
      cadence: input.cadence,
      now: runDate,
      mode,
      horizon,
      baseAmount,
      bounds: input.bounds,
    })

    runs.push({
      runNumber: i + 1,
      scheduledDate: runDate.toISOString().slice(0, 10),
      baseAmount,
      projectedCurrentAmountBeforeRun: balanceBeforeRun,
      shortfallBeforeRun: stepDecision.shortfall,
      unclampedAmount: stepDecision.unclampedAmount,
      appliedAmount: stepDecision.amount,
      clampedBy: stepDecision.clampedBy,
      remainingRuns: stepDecision.remainingRuns,
      projectedGoalValueAtTarget: stepDecision.projectedValue,
      onTrackAfterRun: stepDecision.onTrackAfterRun,
    })

    simulatedCurrent = Number(
      roundDec(toDec(balanceBeforeRun).plus(toDec(stepDecision.amount)))
    )
    totalProjectedContribution = Number(
      roundDec(
        toDec(totalProjectedContribution).plus(toDec(stepDecision.amount))
      )
    )
    runDate = addCadence(input.cadence, runDate)
  }

  // Estimate completion date under current limits
  const targetAmount = Number(toDec(input.goal.targetAmount))
  let estBalance = Number(toDec(input.currentAmount))
  let estCursor = new Date(now.getTime())
  let estimatedCompletionDate: string | null = null
  const maxSimSteps = 520 // up to 10 years of weekly runs

  if (estBalance >= targetAmount) {
    estimatedCompletionDate = now.toISOString().slice(0, 10)
  } else {
    for (let step = 0; step < maxSimSteps; step++) {
      estCursor = addCadence(input.cadence, estCursor)
      const yieldStep = estBalance * (effectiveApy / 100) * stepYears
      const preRun = estBalance + yieldStep
      const stepSizing = computeContribution({
        goal: input.goal,
        currentAmount: preRun,
        actualApy: input.actualApy,
        fallbackApy: input.fallbackApy,
        cadence: input.cadence,
        now: estCursor,
        mode,
        horizon,
        baseAmount,
        bounds: input.bounds,
      })
      estBalance = preRun + stepSizing.amount
      if (estBalance >= targetAmount) {
        estimatedCompletionDate = estCursor.toISOString().slice(0, 10)
        break
      }
    }
  }

  let daysLate = 0
  if (estimatedCompletionDate) {
    const completionMs = new Date(
      `${estimatedCompletionDate}T00:00:00.000Z`
    ).getTime()
    const targetDayMs = new Date(
      `${targetDate.toISOString().slice(0, 10)}T00:00:00.000Z`
    ).getTime()
    if (completionMs > targetDayMs) {
      daysLate = Math.ceil((completionMs - targetDayMs) / (24 * 60 * 60 * 1000))
    }
  }

  const onTrackWithCurrentBounds =
    initialSizing.onTrackAfterRun && daysLate === 0
  const completionSummary = !estimatedCompletionDate
    ? 'At these limits the goal does not reach targetAmount within the 10-year projection window.'
    : daysLate > 0
      ? `At these limits the goal completes ~${estimatedCompletionDate}, ${daysLate} days late.`
      : `At these limits the goal is projected to complete on or before ${estimatedCompletionDate} (on track).`

  return {
    planId: input.planId,
    goalId: input.goalId,
    sizingMode: mode,
    horizon,
    runsCount: runs.length,
    totalProjectedContribution,
    runs,
    onTrackWithCurrentBounds,
    estimatedCompletionDate,
    daysLate,
    completionSummary,
    projectionBasis: initialSizing.projectionBasis,
    disclaimer:
      'This is a projection based on current goal state and non-compounding APY assumptions. ' +
      'Actual APY, protocol yields, and user balances will vary.',
    isSimulation: true,
  }
}
