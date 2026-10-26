/**
 * Multiple concurrent goals with priority-weighted allocation (#358).
 *
 * Goals are views over the same underlying portfolio capital (v1 — separate
 * on-chain sub-accounts per goal are out of scope). Incoming contributions,
 * recurring deposits, snapshot yield, withdrawals, and manual reassignments
 * are attributed across goals via the `GoalAllocation` ledger.
 *
 * Rules:
 * 1. Deterministic ordering: `priority` ASC, then `targetDate` ASC, then
 *    `createdAt` ASC, then `id` ASC.
 * 2. `SEQUENTIAL` mode funds active goals in priority order up to each goal's
 *    remaining headroom (`max(0, targetAmount - currentAmount)`), cascading
 *    any overflow to the next goal.
 * 3. `WEIGHTED` mode splits incoming contributions across active under-target
 *    goals proportional to `allocationWeight` (with iterative water-filling
 *    cascade when a goal's proportional share exceeds its remaining headroom).
 * 4. `ACHIEVED` / `MISSED` / `CANCELLED` goals stop receiving new attribution
 *    but keep their existing attributed balance unless manually reassigned.
 * 5. Yield is attributed proportional to each active goal's current attributed
 *    balance (`currentAmount`), capped by remaining headroom.
 * 6. Withdrawals reduce attributed capital in reverse funding order
 *    (least-priority / highest-weight first), or from position-scoped goals
 *    first when `positionId` is specified.
 * 7. The agent targets the *binding* goal (highest `requiredApy` among
 *    under-funded active goals) and enforces the *stricter* (`Math.max`) of
 *    all active goals' `riskCeiling` values (higher score = lower risk).
 */

import { Prisma } from '@prisma/client'
import {
  calculateRequiredApy,
  calculateYearsRemaining,
} from '../agent/strategies'

export type GoalFundingMode = 'SEQUENTIAL' | 'WEIGHTED'

export type GoalAllocationSourceType =
  | 'DEPOSIT'
  | 'RECURRING_DEPOSIT'
  | 'YIELD'
  | 'REBALANCE_GAIN'
  | 'MANUAL_REASSIGN'
  | 'WITHDRAWAL'

export interface AllocatableGoal {
  id: string
  targetAmount: number | string | Prisma.Decimal
  currentAmount?: number | string | Prisma.Decimal
  startingAmount?: number | string | Prisma.Decimal
  targetDate: Date | string
  createdAt?: Date | string
  priority?: number
  allocationWeight?: number | string | Prisma.Decimal
  fundingMode?: GoalFundingMode | string
  status?: string
  positionId?: string | null
  riskCeiling?: number | null
  includeExternalHoldings?: boolean
}

export interface GoalAllocationSlice {
  goalId: string
  amount: number
  decimalAmount: string
}

export interface AttributeContributionInput {
  amount: number | string | Prisma.Decimal
  goals: AllocatableGoal[]
  mode?: GoalFundingMode
  now?: Date
}

export interface AttributeContributionResult {
  allocations: GoalAllocationSlice[]
  totalAllocated: number
  unallocated: number
  decimalUnallocated: string
}

export interface AttributeYieldInput {
  yieldAmount: number | string | Prisma.Decimal
  goals: AllocatableGoal[]
}

export interface AttributeWithdrawalInput {
  withdrawalAmount: number | string | Prisma.Decimal
  goals: AllocatableGoal[]
  positionId?: string | null
}

export interface AttributeWithdrawalResult {
  reductions: GoalAllocationSlice[] // negative amounts recorded on GoalAllocation
  totalReduced: number
  unallocatedReduction: number
}

export interface ReconciledGoalAllocation {
  goalId: string
  currentAmount: number
  portfolioShare: number
}

export interface ReconcileGoalsResult {
  goals: ReconciledGoalAllocation[]
  totalPortfolioAmount: number
  totalAttributed: number
  unallocated: number
}

export interface BindingGoalSelection {
  bindingGoal: {
    id: string
    targetAmount: number
    startingAmount: number
    currentAmount: number
    targetDate: Date
    requiredApy: number
    riskCeiling: number | null
  }
  effectiveRiskCeiling: number | null
  activeGoalCount: number
}

const SCALE = 8
const EPSILON = new Prisma.Decimal('0.00000001')
const ZERO = new Prisma.Decimal(0)

function toDec(
  value: number | string | Prisma.Decimal | undefined | null
): Prisma.Decimal {
  if (value === undefined || value === null) return ZERO
  if (value instanceof Prisma.Decimal) return value
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ZERO
  return new Prisma.Decimal(String(value))
}

function roundDec(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(SCALE, Prisma.Decimal.ROUND_HALF_UP)
}

function toTimestamp(value: Date | string | undefined): number {
  if (!value) return 0
  const d = value instanceof Date ? value : new Date(value)
  const t = d.getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * Deterministic priority ordering:
 * 1. `priority` ASC (lower number = higher priority, default 100)
 * 2. `targetDate` ASC (sooner deadline wins ties)
 * 3. `createdAt` ASC (older goal wins ties)
 * 4. `id` ASC (final deterministic tie-breaker)
 */
export function sortGoalsByPriority<T extends AllocatableGoal>(
  goals: readonly T[]
): T[] {
  return [...goals].sort((a, b) => {
    const prioA = a.priority ?? 100
    const prioB = b.priority ?? 100
    if (prioA !== prioB) return prioA - prioB

    const targetA = toTimestamp(a.targetDate)
    const targetB = toTimestamp(b.targetDate)
    if (targetA !== targetB) return targetA - targetB

    const createdA = toTimestamp(a.createdAt)
    const createdB = toTimestamp(b.createdAt)
    if (createdA !== createdB) return createdA - createdB

    return a.id.localeCompare(b.id)
  })
}

/**
 * Reverse funding order for withdrawals:
 * Least-priority first (`priority` DESC), then `allocationWeight` DESC (within
 * equal priority), then `targetDate` DESC, then `createdAt` DESC, then `id` DESC.
 */
export function sortGoalsReverseFundingOrder<T extends AllocatableGoal>(
  goals: readonly T[]
): T[] {
  return [...goals].sort((a, b) => {
    const prioA = a.priority ?? 100
    const prioB = b.priority ?? 100
    if (prioA !== prioB) return prioB - prioA

    const weightA = toDec(a.allocationWeight ?? 1)
    const weightB = toDec(b.allocationWeight ?? 1)
    const weightCmp = weightB.comparedTo(weightA)
    if (weightCmp !== 0) return weightCmp

    const targetA = toTimestamp(a.targetDate)
    const targetB = toTimestamp(b.targetDate)
    if (targetA !== targetB) return targetB - targetA

    const createdA = toTimestamp(a.createdAt)
    const createdB = toTimestamp(b.createdAt)
    if (createdA !== createdB) return createdB - createdA

    return b.id.localeCompare(a.id)
  })
}

function getGoalHeadroom(goal: AllocatableGoal): Prisma.Decimal {
  const status = goal.status ?? 'ACTIVE'
  if (status !== 'ACTIVE') return ZERO
  const target = toDec(goal.targetAmount)
  const current = Prisma.Decimal.max(ZERO, toDec(goal.currentAmount ?? 0))
  return Prisma.Decimal.max(ZERO, target.minus(current))
}

/**
 * Pure contribution attribution across concurrent goals (#358).
 *
 * - `SEQUENTIAL`: funds active goals in deterministic priority order up to each
 *   goal's remaining headroom, cascading overflow to the next goal.
 * - `WEIGHTED`: splits across active under-target goals proportional to
 *   `allocationWeight`. If a goal's proportional slice exceeds its headroom to
 *   `targetAmount`, it is capped at `targetAmount` and the excess cascades to
 *   the remaining under-target goals proportionally.
 * - Any remainder after all active goals reach `targetAmount` is returned as
 *   `unallocated`.
 */
export function attributeContribution(
  input: AttributeContributionInput
): AttributeContributionResult {
  const totalAmount = roundDec(Prisma.Decimal.max(ZERO, toDec(input.amount)))
  const ordered = sortGoalsByPriority(input.goals)
  const allocMap = new Map<string, Prisma.Decimal>()
  for (const g of ordered) {
    allocMap.set(g.id, ZERO)
  }

  if (totalAmount.lte(ZERO) || ordered.length === 0) {
    return {
      allocations: ordered.map((g) => ({
        goalId: g.id,
        amount: 0,
        decimalAmount: '0',
      })),
      totalAllocated: 0,
      unallocated: Number(totalAmount),
      decimalUnallocated: totalAmount.toString(),
    }
  }

  const resolvedMode: GoalFundingMode =
    input.mode ??
    (ordered.some((g) => g.fundingMode === 'WEIGHTED')
      ? 'WEIGHTED'
      : 'SEQUENTIAL')

  let remaining = totalAmount
  const headroomById = new Map<string, Prisma.Decimal>()
  for (const g of ordered) {
    headroomById.set(g.id, roundDec(getGoalHeadroom(g)))
  }

  if (resolvedMode === 'SEQUENTIAL') {
    for (const g of ordered) {
      if (remaining.lte(ZERO)) break
      const headroom = headroomById.get(g.id) ?? ZERO
      if (headroom.lte(ZERO)) continue
      const slice = Prisma.Decimal.min(remaining, headroom)
      allocMap.set(g.id, roundDec(slice))
      headroomById.set(g.id, roundDec(headroom.minus(slice)))
      remaining = roundDec(remaining.minus(slice))
    }
  } else {
    // WEIGHTED with water-filling overflow cascade
    let candidates = ordered.filter((g) =>
      (headroomById.get(g.id) ?? ZERO).gt(EPSILON)
    )

    while (remaining.gt(EPSILON) && candidates.length > 0) {
      const weights = new Map<string, Prisma.Decimal>()
      let totalWeight = ZERO
      for (const g of candidates) {
        const w = Prisma.Decimal.max(ZERO, toDec(g.allocationWeight ?? 1))
        const effectiveW = w.gt(ZERO) ? w : new Prisma.Decimal(1)
        weights.set(g.id, effectiveW)
        totalWeight = totalWeight.plus(effectiveW)
      }

      if (totalWeight.lte(ZERO)) break

      let anyCapped = false
      let roundAllocated = ZERO

      for (const g of candidates) {
        const w = weights.get(g.id)!
        const headroom = headroomById.get(g.id) ?? ZERO
        const rawShare = roundDec(remaining.mul(w).div(totalWeight))
        if (rawShare.gte(headroom)) {
          // Cap at headroom and cascade excess in next iteration
          allocMap.set(
            g.id,
            roundDec((allocMap.get(g.id) ?? ZERO).plus(headroom))
          )
          headroomById.set(g.id, ZERO)
          roundAllocated = roundDec(roundAllocated.plus(headroom))
          anyCapped = true
        }
      }

      if (anyCapped) {
        remaining = roundDec(
          Prisma.Decimal.max(ZERO, remaining.minus(roundAllocated))
        )
        candidates = candidates.filter((g) =>
          (headroomById.get(g.id) ?? ZERO).gt(EPSILON)
        )
        continue
      }

      // No goal hit its cap in this pass — distribute proportionally and assign
      // any sub-cent rounding dust to the highest-priority candidate with headroom.
      let distributed = ZERO
      for (let i = 0; i < candidates.length; i++) {
        const g = candidates[i]
        const w = weights.get(g.id)!
        const headroom = headroomById.get(g.id) ?? ZERO
        const share =
          i === candidates.length - 1
            ? Prisma.Decimal.min(
                headroom,
                roundDec(remaining.minus(distributed))
              )
            : Prisma.Decimal.min(
                headroom,
                roundDec(remaining.mul(w).div(totalWeight))
              )
        const cleanShare = Prisma.Decimal.max(ZERO, share)
        allocMap.set(
          g.id,
          roundDec((allocMap.get(g.id) ?? ZERO).plus(cleanShare))
        )
        headroomById.set(g.id, roundDec(headroom.minus(cleanShare)))
        distributed = roundDec(distributed.plus(cleanShare))
      }
      remaining = roundDec(
        Prisma.Decimal.max(ZERO, remaining.minus(distributed))
      )
      break
    }
  }

  let totalAllocatedDec = ZERO
  const allocations: GoalAllocationSlice[] = ordered.map((g) => {
    const dec = roundDec(allocMap.get(g.id) ?? ZERO)
    totalAllocatedDec = roundDec(totalAllocatedDec.plus(dec))
    return {
      goalId: g.id,
      amount: Number(dec),
      decimalAmount: dec.toString(),
    }
  })

  const unallocatedDec = roundDec(
    Prisma.Decimal.max(ZERO, totalAmount.minus(totalAllocatedDec))
  )

  return {
    allocations,
    totalAllocated: Number(totalAllocatedDec),
    unallocated: Number(unallocatedDec),
    decimalUnallocated: unallocatedDec.toString(),
  }
}

/**
 * Attribute snapshot yield across active goals proportional to each goal's
 * current attributed balance (`currentAmount`).
 *
 * A goal that holds more of the user's capital earns a proportional share of
 * the yield, capped at its remaining target headroom (overflow cascades to
 * remaining active goals or into `unallocated`).
 */
export function attributeYield(
  input: AttributeYieldInput
): AttributeContributionResult {
  const yieldDec = roundDec(Prisma.Decimal.max(ZERO, toDec(input.yieldAmount)))
  const ordered = sortGoalsByPriority(input.goals)

  if (yieldDec.lte(ZERO) || ordered.length === 0) {
    return {
      allocations: ordered.map((g) => ({
        goalId: g.id,
        amount: 0,
        decimalAmount: '0',
      })),
      totalAllocated: 0,
      unallocated: Number(yieldDec),
      decimalUnallocated: yieldDec.toString(),
    }
  }

  // Weight each active goal by its current attributed balance
  const activeWithBalance = ordered.filter(
    (g) =>
      (g.status ?? 'ACTIVE') === 'ACTIVE' &&
      toDec(g.currentAmount ?? 0).gt(ZERO) &&
      getGoalHeadroom(g).gt(ZERO)
  )

  if (activeWithBalance.length === 0) {
    return {
      allocations: ordered.map((g) => ({
        goalId: g.id,
        amount: 0,
        decimalAmount: '0',
      })),
      totalAllocated: 0,
      unallocated: Number(yieldDec),
      decimalUnallocated: yieldDec.toString(),
    }
  }

  const weightedGoals: AllocatableGoal[] = ordered.map((g) => {
    const current = Prisma.Decimal.max(ZERO, toDec(g.currentAmount ?? 0))
    const isEligible =
      (g.status ?? 'ACTIVE') === 'ACTIVE' &&
      current.gt(ZERO) &&
      getGoalHeadroom(g).gt(ZERO)
    return {
      ...g,
      status: isEligible ? 'ACTIVE' : 'ACHIEVED',
      allocationWeight: isEligible ? current : ZERO,
    }
  })

  return attributeContribution({
    amount: yieldDec,
    goals: weightedGoals,
    mode: 'WEIGHTED',
  })
}

/**
 * Reduce attributed capital on withdrawal (#358).
 *
 * Follows reverse funding order (least-priority / highest-weight first) so the
 * user's highest-priority goals are preserved longest. When `positionId` is
 * supplied, goals explicitly linked to that `positionId` are reduced first.
 * No goal's attributed balance may ever drop below 0.
 */
export function attributeWithdrawal(
  input: AttributeWithdrawalInput
): AttributeWithdrawalResult {
  const totalWithdrawal = roundDec(
    Prisma.Decimal.max(ZERO, toDec(input.withdrawalAmount))
  )
  const reverseOrdered = sortGoalsReverseFundingOrder(input.goals)

  const orderedForReduction = input.positionId
    ? [
        ...reverseOrdered.filter((g) => g.positionId === input.positionId),
        ...reverseOrdered.filter((g) => g.positionId !== input.positionId),
      ]
    : reverseOrdered

  let remainingToReduce = totalWithdrawal
  const reductionById = new Map<string, Prisma.Decimal>()
  for (const g of input.goals) {
    reductionById.set(g.id, ZERO)
  }

  for (const g of orderedForReduction) {
    if (remainingToReduce.lte(ZERO)) break
    const held = roundDec(Prisma.Decimal.max(ZERO, toDec(g.currentAmount ?? 0)))
    if (held.lte(ZERO)) continue
    const reduceBy = Prisma.Decimal.min(held, remainingToReduce)
    reductionById.set(g.id, roundDec(reduceBy.negated()))
    remainingToReduce = roundDec(remainingToReduce.minus(reduceBy))
  }

  let totalReducedDec = ZERO
  const reductions: GoalAllocationSlice[] = sortGoalsByPriority(
    input.goals
  ).map((g) => {
    const dec = reductionById.get(g.id) ?? ZERO
    totalReducedDec = roundDec(totalReducedDec.plus(dec.abs()))
    return {
      goalId: g.id,
      amount: Number(dec),
      decimalAmount: dec.toString(),
    }
  })

  return {
    reductions,
    totalReduced: Number(totalReducedDec),
    unallocatedReduction: Number(remainingToReduce),
  }
}

/**
 * Reconcile per-goal attributed balances against total portfolio capital.
 *
 * Clamps each goal's attributed balance to `>= 0` and computes `portfolioShare`
 * plus the `unallocated` remainder (`max(0, totalPortfolioAmount - totalAttributed)`).
 */
export function reconcileUserGoalAllocations(params: {
  totalPortfolioAmount: number | string | Prisma.Decimal
  goals: Array<{
    id: string
    attributedAmount: number | string | Prisma.Decimal
  }>
}): ReconcileGoalsResult {
  const totalPortfolioDec = roundDec(
    Prisma.Decimal.max(ZERO, toDec(params.totalPortfolioAmount))
  )

  let totalAttributedDec = ZERO
  const goals: ReconciledGoalAllocation[] = params.goals.map((g) => {
    const clamped = roundDec(
      Prisma.Decimal.max(ZERO, toDec(g.attributedAmount))
    )
    totalAttributedDec = roundDec(totalAttributedDec.plus(clamped))
    const share = totalPortfolioDec.gt(ZERO)
      ? Number(clamped.div(totalPortfolioDec).toDecimalPlaces(6))
      : 0
    return {
      goalId: g.id,
      currentAmount: Number(clamped),
      portfolioShare: share,
    }
  })

  const unallocatedDec = roundDec(
    Prisma.Decimal.max(ZERO, totalPortfolioDec.minus(totalAttributedDec))
  )

  return {
    goals,
    totalPortfolioAmount: Number(totalPortfolioDec),
    totalAttributed: Number(totalAttributedDec),
    unallocated: Number(unallocatedDec),
  }
}

/**
 * Select the binding goal for the agent's `GoalTrackingStrategy` (#358).
 *
 * - Single active goal: returns that exact goal's `{ targetAmount, startingAmount,
 *   targetDate, riskCeiling }` so single-goal behavior is byte-for-byte identical
 *   to #281.
 * - Multiple active goals: picks the under-funded goal (`currentAmount < targetAmount`)
 *   with the highest `requiredApy` (ties broken by `sortGoalsByPriority`).
 *   Effective `riskCeiling` is the strictest (`Math.max`, since higher score =
 *   safer protocol) across all active goals that configure a ceiling.
 */
export function selectBindingGoal(
  goals: readonly AllocatableGoal[],
  now: Date = new Date()
): BindingGoalSelection | null {
  const activePlatformGoals = sortGoalsByPriority(
    goals.filter(
      (g) => (g.status ?? 'ACTIVE') === 'ACTIVE' && !g.includeExternalHoldings
    )
  )

  if (activePlatformGoals.length === 0) return null

  // Effective risk ceiling across all active goals: stricter = maximum minimum score
  const ceilings = activePlatformGoals
    .map((g) => g.riskCeiling)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
  const effectiveRiskCeiling =
    ceilings.length > 0 ? Math.max(...ceilings) : null

  // Single-goal backward-compatibility lock: preserve startingAmount and targetAmount verbatim
  if (activePlatformGoals.length === 1) {
    const single = activePlatformGoals[0]
    const targetAmount = Number(toDec(single.targetAmount))
    const startingAmount = Number(
      toDec(single.startingAmount ?? single.currentAmount ?? 0)
    )
    const currentAmount = Number(
      toDec(
        single.currentAmount !== undefined
          ? single.currentAmount
          : startingAmount
      )
    )
    const targetDate =
      single.targetDate instanceof Date
        ? single.targetDate
        : new Date(single.targetDate)
    const requiredApy = calculateRequiredApy(
      startingAmount,
      targetAmount,
      calculateYearsRemaining(targetDate, now)
    )
    return {
      bindingGoal: {
        id: single.id,
        targetAmount,
        startingAmount,
        currentAmount,
        targetDate,
        requiredApy,
        riskCeiling: effectiveRiskCeiling,
      },
      effectiveRiskCeiling,
      activeGoalCount: 1,
    }
  }

  // Multiple active goals: evaluate requiredApy on under-funded goals
  const scored = activePlatformGoals.map((g) => {
    const targetAmount = Number(toDec(g.targetAmount))
    const startingAmount = Number(toDec(g.startingAmount ?? 0))
    const hasAttributed =
      g.currentAmount !== undefined && g.currentAmount !== null
    const currentAmount = hasAttributed
      ? Number(Prisma.Decimal.max(ZERO, toDec(g.currentAmount)))
      : startingAmount
    const basisAmount = currentAmount > 0 ? currentAmount : startingAmount
    const targetDate =
      g.targetDate instanceof Date ? g.targetDate : new Date(g.targetDate)
    const yearsRemaining = calculateYearsRemaining(targetDate, now)
    const underFunded = currentAmount < targetAmount
    const requiredApy = underFunded
      ? calculateRequiredApy(basisAmount, targetAmount, yearsRemaining)
      : 0
    return {
      goal: g,
      targetAmount,
      startingAmount: basisAmount,
      currentAmount,
      targetDate,
      underFunded,
      requiredApy,
    }
  })

  const underFundedPool = scored.filter((s) => s.underFunded)
  const pool = underFundedPool.length > 0 ? underFundedPool : scored

  // Highest requiredApy wins; ties broken by priority order (already sorted by sortGoalsByPriority)
  let winner = pool[0]
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i]
    if (candidate.requiredApy > winner.requiredApy) {
      winner = candidate
    }
  }

  return {
    bindingGoal: {
      id: winner.goal.id,
      targetAmount: winner.targetAmount,
      startingAmount: winner.startingAmount,
      currentAmount: winner.currentAmount,
      targetDate: winner.targetDate,
      requiredApy: winner.requiredApy,
      riskCeiling: effectiveRiskCeiling,
    },
    effectiveRiskCeiling,
    activeGoalCount: activePlatformGoals.length,
  }
}
