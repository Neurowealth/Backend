/**
 * Goal-based investing (#281, #358) — business logic for SavingsGoal CRUD,
 * multiple concurrent goals with priority-weighted allocation, manual
 * reassignment, and progress projection.
 *
 * Required-rate math intentionally reuses the same simple (non-compounding)
 * convention as calculateApy/calculateYearsActive in ../agent/snapshotter.ts
 * and ../agent/strategies.ts (GoalTrackingStrategy), so the agent's rebalance
 * decisions and this endpoint's "on track" reporting never disagree.
 * Compounding-aware modeling is tracked separately in #225.
 */
import { Prisma } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import {
  EXTERNAL_WALLET_STALE_AFTER_MS,
  valueExternalBalanceUsd,
} from '../externalWallets/service'
import type { ExternalWalletBalance } from '../stellar/externalWalletBalances'
import { logAgentAction } from '../agent/router'
import { scanAllProtocols } from '../agent/scanner'
import {
  applyRiskCeiling,
  calculateRequiredApy,
  calculateYearsRemaining,
} from '../agent/strategies'
import {
  attributeContribution,
  attributeYield,
  attributeWithdrawal,
  reconcileUserGoalAllocations,
  sortGoalsByPriority,
  type GoalFundingMode,
  type GoalAllocationSourceType,
} from './allocation'

type Db = typeof db | Prisma.TransactionClient

export class GoalConflictError extends Error {}
export class GoalNotFoundError extends Error {}
export class GoalValidationError extends Error {}

export interface CreateGoalInput {
  targetAmount: number
  targetDate: Date
  startingAmount?: number
  positionId?: string
  riskCeiling?: number
  includeExternalHoldings?: boolean
  priority?: number
  allocationWeight?: number | string
  fundingMode?: GoalFundingMode
}

export interface UpdateGoalInput {
  targetAmount?: number
  targetDate?: Date
  riskCeiling?: number
  includeExternalHoldings?: boolean
  priority?: number
  allocationWeight?: number | string
  fundingMode?: GoalFundingMode
}

export interface GoalProgress {
  goalId: string
  status: string
  targetAmount: number
  startingAmount: number
  currentAmount: number
  targetDate: string
  requiredApy: number
  actualApy: number
  onTrack: boolean
  reachable: boolean
  projectedCompletionDate: string | null
  includeExternalHoldings: boolean
  externalStaleWalletCount: number
  unpricedExternalHoldingCount: number
  priority?: number
  allocationWeight?: number
  fundingMode?: GoalFundingMode
  portfolioShare?: number
  note?: string
}

export interface MultiGoalListItem {
  goal: any
  progress: GoalProgress
  currentAmount: number
  portfolioShare: number
}

export interface MultiGoalListResult {
  goals: MultiGoalListItem[]
  totalPortfolioAmount: number
  totalAttributed: number
  unallocated: number
  goalFundingMode: GoalFundingMode
}

interface CurrentAmountSnapshot {
  platformAmount: number
  externalAmount: number
  externalStaleWalletCount: number
  unpricedExternalHoldingCount: number
}

async function resolveCurrentAmounts(
  userId: string,
  positionId: string | null | undefined,
  database: Db,
  includeExternalHoldings = false
): Promise<CurrentAmountSnapshot> {
  let platformValue: number
  if (positionId) {
    const position = await (database as any).position.findUnique({
      where: { id: positionId },
    })
    if (!position || position.userId !== userId) {
      return {
        platformAmount: 0,
        externalAmount: 0,
        externalStaleWalletCount: 0,
        unpricedExternalHoldingCount: 0,
      }
    }
    platformValue = Number(position.currentValue)
  } else {
    const positions = await (database as any).position.findMany({
      where: { userId, status: 'ACTIVE' },
    })
    platformValue = positions.reduce(
      (sum: number, p: any) => sum + Number(p.currentValue),
      0
    )
  }

  if (!includeExternalHoldings) {
    return {
      platformAmount: platformValue,
      externalAmount: 0,
      externalStaleWalletCount: 0,
      unpricedExternalHoldingCount: 0,
    }
  }
  const wallets = await (database as any).linkedExternalWallet.findMany({
    where: { userId },
    select: {
      balances: true,
      lastSyncedAt: true,
      lastSyncAttemptAt: true,
      syncError: true,
    },
  })
  let externalAmount = 0
  let unpricedExternalHoldingCount = 0
  let externalStaleWalletCount = 0
  const now = Date.now()

  for (const wallet of wallets) {
    const lastSyncedAt = wallet.lastSyncedAt as Date | null
    if (
      !lastSyncedAt ||
      wallet.syncError ||
      (wallet.lastSyncAttemptAt && wallet.lastSyncAttemptAt > lastSyncedAt) ||
      now - lastSyncedAt.getTime() > EXTERNAL_WALLET_STALE_AFTER_MS
    ) {
      externalStaleWalletCount++
    }
    if (!Array.isArray(wallet.balances)) continue
    for (const value of wallet.balances) {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as ExternalWalletBalance).amount !== 'string' ||
        typeof (value as ExternalWalletBalance).assetCode !== 'string'
      ) {
        continue
      }
      const balance = value as ExternalWalletBalance
      const usdValue = valueExternalBalanceUsd(balance)
      if (usdValue === null) {
        unpricedExternalHoldingCount++
      } else {
        externalAmount += usdValue
      }
    }
  }

  return {
    platformAmount: platformValue,
    externalAmount,
    externalStaleWalletCount,
    unpricedExternalHoldingCount,
  }
}

/**
 * Sum GoalAllocation rows for a set of goalIds.
 * Returns null if `goalAllocation` is not available on the database instance
 * (e.g. legacy unit test mocks that do not mock `goalAllocation`).
 */
export async function getAttributedAmountsByGoalId(
  goalIds: string[],
  database: Db = db
): Promise<Map<string, number> | null> {
  const gaModel = (database as any).goalAllocation
  if (!gaModel || typeof gaModel.findMany !== 'function') {
    return null
  }
  if (goalIds.length === 0) return new Map()

  const rows = await gaModel.findMany({
    where: { goalId: { in: goalIds } },
    select: { goalId: true, amount: true },
  })

  if (!Array.isArray(rows) || rows.length === 0) {
    return new Map()
  }

  const sums = new Map<string, Prisma.Decimal>()
  for (const row of rows) {
    const prev = sums.get(row.goalId) ?? new Prisma.Decimal(0)
    sums.set(row.goalId, prev.plus(new Prisma.Decimal(String(row.amount))))
  }

  const out = new Map<string, number>()
  for (const [gid, sum] of sums.entries()) {
    out.set(gid, Math.max(0, Number(sum)))
  }
  return out
}

/**
 * Create a savings goal (#281, #358). Multiple concurrent ACTIVE goals per user
 * are supported with `priority`, `allocationWeight`, and `fundingMode`.
 *
 * When targetAmount is already met by the (possibly defaulted) starting
 * amount, the goal is created directly as ACHIEVED rather than a misleading
 * "in progress" ACTIVE record.
 */
export async function createGoal(
  userId: string,
  input: CreateGoalInput,
  database: Db = db
): Promise<any> {
  const startingAmount =
    input.startingAmount ??
    (await resolveCurrentAmounts(userId, input.positionId, database))
      .platformAmount

  const status = input.targetAmount <= startingAmount ? 'ACHIEVED' : 'ACTIVE'
  const priority = input.priority ?? 100
  const allocationWeight =
    input.allocationWeight !== undefined
      ? new Prisma.Decimal(String(input.allocationWeight))
      : new Prisma.Decimal(1)
  const fundingMode: GoalFundingMode = input.fundingMode ?? 'SEQUENTIAL'

  const goal = await (database as any).savingsGoal.create({
    data: {
      userId,
      positionId: input.positionId ?? null,
      targetAmount: input.targetAmount,
      startingAmount,
      targetDate: input.targetDate,
      riskCeiling: input.riskCeiling ?? null,
      includeExternalHoldings: input.includeExternalHoldings ?? false,
      priority,
      allocationWeight,
      fundingMode,
      status,
    },
  })

  logger.info('Savings goal created', {
    userId,
    goalId: goal.id,
    status,
    priority,
    fundingMode,
  })

  return goal
}

/**
 * The user's current goal: their highest-priority ACTIVE goal if one exists,
 * otherwise their most recently created goal, otherwise null.
 */
export async function getGoalForUser(
  userId: string,
  database: Db = db
): Promise<any | null> {
  const sgModel = (database as any).savingsGoal
  if (typeof sgModel.findMany === 'function') {
    const activeGoals = await sgModel.findMany({
      where: { userId, status: 'ACTIVE' },
    })
    if (Array.isArray(activeGoals) && activeGoals.length > 0) {
      return sortGoalsByPriority(activeGoals)[0]
    }
  } else if (typeof sgModel.findFirst === 'function') {
    const active = await sgModel.findFirst({
      where: { userId, status: 'ACTIVE' },
    })
    if (active) return active
  }

  return sgModel.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getGoalById(
  id: string,
  database: Db = db
): Promise<any | null> {
  return (database as any).savingsGoal.findUnique({ where: { id } })
}

/**
 * Update target amount/date/riskCeiling/priority/allocationWeight/fundingMode
 * on an ACTIVE goal.
 */
export async function updateGoal(
  id: string,
  updates: UpdateGoalInput,
  database: Db = db
): Promise<any> {
  const goal = await getGoalById(id, database)
  if (!goal) {
    throw new GoalNotFoundError('Savings goal not found')
  }
  if (goal.status !== 'ACTIVE') {
    throw new GoalValidationError('Only an ACTIVE goal can be updated')
  }

  return (database as any).savingsGoal.update({
    where: { id },
    data: {
      ...(updates.targetAmount !== undefined
        ? { targetAmount: updates.targetAmount }
        : {}),
      ...(updates.targetDate !== undefined
        ? { targetDate: updates.targetDate }
        : {}),
      ...(updates.riskCeiling !== undefined
        ? { riskCeiling: updates.riskCeiling }
        : {}),
      ...(updates.includeExternalHoldings !== undefined
        ? { includeExternalHoldings: updates.includeExternalHoldings }
        : {}),
      ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
      ...(updates.allocationWeight !== undefined
        ? {
            allocationWeight: new Prisma.Decimal(
              String(updates.allocationWeight)
            ),
          }
        : {}),
      ...(updates.fundingMode !== undefined
        ? { fundingMode: updates.fundingMode }
        : {}),
    },
  })
}

/** Soft-cancel: sets status = CANCELLED, never hard-deletes. */
export async function cancelGoal(id: string, database: Db = db): Promise<any> {
  const goal = await getGoalById(id, database)
  if (!goal) {
    throw new GoalNotFoundError('Savings goal not found')
  }
  if (goal.status !== 'ACTIVE') {
    return goal
  }

  return (database as any).savingsGoal.update({
    where: { id },
    data: { status: 'CANCELLED' },
  })
}

/**
 * Record a contribution (DEPOSIT / RECURRING_DEPOSIT / REBALANCE_GAIN) across
 * a user's active goals in the `GoalAllocation` ledger (#358).
 */
export async function recordContributionAttribution(params: {
  userId: string
  amount: number | string | Prisma.Decimal
  sourceType: Extract<
    GoalAllocationSourceType,
    'DEPOSIT' | 'RECURRING_DEPOSIT' | 'REBALANCE_GAIN'
  >
  sourceId?: string | null
  mode?: GoalFundingMode
  database?: Db
}) {
  const database = params.database ?? db
  const sgModel = (database as any).savingsGoal
  const gaModel = (database as any).goalAllocation
  if (!sgModel || !gaModel) {
    return {
      allocations: [],
      totalAllocated: 0,
      unallocated: Number(params.amount),
      decimalUnallocated: String(params.amount),
    }
  }

  const goals = await sgModel.findMany({
    where: { userId: params.userId, status: 'ACTIVE' },
  })
  if (!Array.isArray(goals) || goals.length === 0) {
    return {
      allocations: [],
      totalAllocated: 0,
      unallocated: Number(params.amount),
      decimalUnallocated: String(params.amount),
    }
  }

  const attributedMap =
    (await getAttributedAmountsByGoalId(
      goals.map((g: any) => g.id),
      database
    )) ?? new Map<string, number>()

  let resolvedMode: GoalFundingMode | undefined = params.mode
  if (!resolvedMode && (database as any).user?.findUnique) {
    const userRow = await (database as any).user.findUnique({
      where: { id: params.userId },
      select: { goalFundingMode: true },
    })
    if (
      userRow?.goalFundingMode === 'WEIGHTED' ||
      userRow?.goalFundingMode === 'SEQUENTIAL'
    ) {
      resolvedMode = userRow.goalFundingMode
    }
  }

  const enrichedGoals = goals.map((g: any) => ({
    ...g,
    currentAmount: attributedMap.get(g.id) ?? 0,
  }))

  const result = attributeContribution({
    amount: params.amount,
    goals: enrichedGoals,
    mode: resolvedMode,
  })

  for (const slice of result.allocations) {
    if (slice.amount <= 0) continue
    await gaModel.create({
      data: {
        goalId: slice.goalId,
        sourceType: params.sourceType,
        sourceId: params.sourceId ?? null,
        amount: new Prisma.Decimal(slice.decimalAmount),
      },
    })

    const goal = goals.find((g: any) => g.id === slice.goalId)
    if (goal) {
      const newBalance = (attributedMap.get(goal.id) ?? 0) + slice.amount
      if (newBalance >= Number(goal.targetAmount) && goal.status === 'ACTIVE') {
        await sgModel.update({
          where: { id: goal.id },
          data: { status: 'ACHIEVED' },
        })
      }
    }
  }

  return result
}

/**
 * Record snapshot yield attribution across a user's active goals proportional
 * to each goal's current attributed balance (#358).
 */
export async function recordYieldAttribution(params: {
  userId: string
  yieldAmount: number | string | Prisma.Decimal
  sourceId?: string | null
  database?: Db
}) {
  const database = params.database ?? db
  const sgModel = (database as any).savingsGoal
  const gaModel = (database as any).goalAllocation
  if (!sgModel || !gaModel) {
    return {
      allocations: [],
      totalAllocated: 0,
      unallocated: Number(params.yieldAmount),
      decimalUnallocated: String(params.yieldAmount),
    }
  }

  const goals = await sgModel.findMany({
    where: { userId: params.userId, status: 'ACTIVE' },
  })
  if (!Array.isArray(goals) || goals.length === 0) {
    return {
      allocations: [],
      totalAllocated: 0,
      unallocated: Number(params.yieldAmount),
      decimalUnallocated: String(params.yieldAmount),
    }
  }

  const attributedMap =
    (await getAttributedAmountsByGoalId(
      goals.map((g: any) => g.id),
      database
    )) ?? new Map<string, number>()

  const enrichedGoals = goals.map((g: any) => ({
    ...g,
    currentAmount: attributedMap.get(g.id) ?? 0,
  }))

  const result = attributeYield({
    yieldAmount: params.yieldAmount,
    goals: enrichedGoals,
  })

  for (const slice of result.allocations) {
    if (slice.amount <= 0) continue
    await gaModel.create({
      data: {
        goalId: slice.goalId,
        sourceType: 'YIELD',
        sourceId: params.sourceId ?? null,
        amount: new Prisma.Decimal(slice.decimalAmount),
      },
    })

    const goal = goals.find((g: any) => g.id === slice.goalId)
    if (goal) {
      const newBalance = (attributedMap.get(goal.id) ?? 0) + slice.amount
      if (newBalance >= Number(goal.targetAmount) && goal.status === 'ACTIVE') {
        await sgModel.update({
          where: { id: goal.id },
          data: { status: 'ACHIEVED' },
        })
      }
    }
  }

  return result
}

/**
 * Record withdrawal reduction across a user's goals in reverse funding order
 * (or position-scoped first) (#358).
 */
export async function recordWithdrawalAttribution(params: {
  userId: string
  withdrawalAmount: number | string | Prisma.Decimal
  positionId?: string | null
  sourceId?: string | null
  database?: Db
}) {
  const database = params.database ?? db
  const sgModel = (database as any).savingsGoal
  const gaModel = (database as any).goalAllocation
  if (!sgModel || !gaModel) {
    return {
      reductions: [],
      totalReduced: 0,
      unallocatedReduction: Number(params.withdrawalAmount),
    }
  }

  const goals = await sgModel.findMany({
    where: { userId: params.userId },
  })
  if (!Array.isArray(goals) || goals.length === 0) {
    return {
      reductions: [],
      totalReduced: 0,
      unallocatedReduction: Number(params.withdrawalAmount),
    }
  }

  const attributedMap =
    (await getAttributedAmountsByGoalId(
      goals.map((g: any) => g.id),
      database
    )) ?? new Map<string, number>()

  const enrichedGoals = goals.map((g: any) => ({
    ...g,
    currentAmount: attributedMap.get(g.id) ?? 0,
  }))

  const result = attributeWithdrawal({
    withdrawalAmount: params.withdrawalAmount,
    goals: enrichedGoals,
    positionId: params.positionId,
  })

  for (const red of result.reductions) {
    if (red.amount === 0) continue
    await gaModel.create({
      data: {
        goalId: red.goalId,
        sourceType: 'WITHDRAWAL',
        sourceId: params.sourceId ?? null,
        amount: new Prisma.Decimal(red.decimalAmount),
      },
    })
  }

  return result
}

/**
 * Manually reassign attributed capital from `fromGoalId` to `toGoalId` (#358).
 *
 * Owner-scoped: both goals must belong to `userId`. Rejects with a
 * `GoalValidationError` (including the available attributed balance) when the
 * requested amount exceeds what `fromGoalId` currently holds. Writes paired
 * `MANUAL_REASSIGN` rows (`-amount` and `+amount`) so the total attributed sum
 * across the user's goals is strictly preserved.
 */
export async function reassignGoalAllocation(params: {
  userId: string
  fromGoalId: string
  toGoalId: string
  amount: number
  database?: Db
}): Promise<{
  fromGoalId: string
  toGoalId: string
  reassignedAmount: number
  fromGoalCurrentAmount: number
  toGoalCurrentAmount: number
}> {
  const database = params.database ?? db
  if (params.fromGoalId === params.toGoalId) {
    throw new GoalValidationError(
      'Source and destination goals must be different'
    )
  }
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new GoalValidationError('Reassign amount must be greater than 0')
  }

  const [fromGoal, toGoal] = await Promise.all([
    getGoalById(params.fromGoalId, database),
    getGoalById(params.toGoalId, database),
  ])

  if (!fromGoal || fromGoal.userId !== params.userId) {
    throw new GoalNotFoundError('Source savings goal not found')
  }
  if (!toGoal || toGoal.userId !== params.userId) {
    throw new GoalNotFoundError('Destination savings goal not found')
  }
  if (toGoal.status === 'CANCELLED') {
    throw new GoalValidationError(
      'Cannot reassign capital into a cancelled savings goal'
    )
  }

  const attributedMap =
    (await getAttributedAmountsByGoalId([fromGoal.id, toGoal.id], database)) ??
    new Map<string, number>()

  const availableFrom = attributedMap.get(fromGoal.id) ?? 0
  if (params.amount > availableFrom + 1e-9) {
    throw new GoalValidationError(
      `Cannot reassign ${params.amount}: source goal only holds ${availableFrom} attributed capital (available: ${availableFrom})`
    )
  }

  const amountDec = new Prisma.Decimal(String(params.amount))
  const gaModel = (database as any).goalAllocation
  const sgModel = (database as any).savingsGoal

  const runWrite = async (tx: any) => {
    const txGa = tx.goalAllocation ?? gaModel
    const txSg = tx.savingsGoal ?? sgModel
    await txGa.create({
      data: {
        goalId: fromGoal.id,
        sourceType: 'MANUAL_REASSIGN',
        sourceId: toGoal.id,
        amount: amountDec.negated(),
      },
    })
    await txGa.create({
      data: {
        goalId: toGoal.id,
        sourceType: 'MANUAL_REASSIGN',
        sourceId: fromGoal.id,
        amount: amountDec,
      },
    })

    const nextToAmount = (attributedMap.get(toGoal.id) ?? 0) + params.amount
    if (
      nextToAmount >= Number(toGoal.targetAmount) &&
      toGoal.status === 'ACTIVE'
    ) {
      await txSg.update({
        where: { id: toGoal.id },
        data: { status: 'ACHIEVED' },
      })
    }
  }

  if (typeof (database as any).$transaction === 'function') {
    await (database as any).$transaction(runWrite)
  } else {
    await runWrite(database)
  }

  return {
    fromGoalId: fromGoal.id,
    toGoalId: toGoal.id,
    reassignedAmount: params.amount,
    fromGoalCurrentAmount: Math.max(0, availableFrom - params.amount),
    toGoalCurrentAmount: (attributedMap.get(toGoal.id) ?? 0) + params.amount,
  }
}

/**
 * Recent (30d) simple average APY across the user's active positions.
 */
async function resolveActualApy(userId: string, database: Db): Promise<number> {
  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const snapshots = await (database as any).yieldSnapshot.findMany({
    where: { position: { is: { userId } }, snapshotAt: { gte: fromDate } },
  })
  if (snapshots.length === 0) return 0
  return (
    snapshots.reduce((sum: number, s: any) => sum + Number(s.apy), 0) /
    snapshots.length
  )
}

/**
 * Whether the goal's required rate is achievable given currently scanned
 * protocols and the goal's riskCeiling.
 */
async function resolveReachability(
  requiredApy: number,
  riskCeiling: number | null
): Promise<{ reachable: boolean; maxEligibleApy: number }> {
  if (requiredApy <= 0) return { reachable: true, maxEligibleApy: requiredApy }

  const allProtocols = await scanAllProtocols()
  if (allProtocols.length === 0) {
    return { reachable: false, maxEligibleApy: 0 }
  }

  let eligible = allProtocols
  if (riskCeiling !== null && riskCeiling !== undefined) {
    const scores: Record<string, number> = {}
    const riskRows = await db.protocolRiskScore.findMany({
      select: { protocolName: true, score: true },
    })
    for (const row of riskRows as Array<{
      protocolName: string
      score: number
    }>) {
      scores[row.protocolName] = row.score
    }
    eligible = applyRiskCeiling(allProtocols, riskCeiling, scores)
  }

  const maxEligibleApy =
    eligible.length > 0 ? Math.max(...eligible.map((p) => p.apy)) : 0
  return { reachable: requiredApy <= maxEligibleApy, maxEligibleApy }
}

/**
 * Compute trajectory for a goal: current amount, required vs. actual APY,
 * projected completion date, and whether the target is reachable within the
 * user's risk tolerance.
 *
 * Backward compatibility (#358):
 * - When `GoalAllocation` rows exist for the goal (or an explicit
 *   `overrideAttributedPlatformAmount` is supplied by `listGoalsWithProgress`),
 *   `platformAmount` is the goal's attributed balance from `GoalAllocation`.
 * - When the user has a single goal and no `GoalAllocation` rows have been
 *   recorded yet (the pre-#358 path), `platformAmount` falls back to the sum of
 *   `Position.currentValue` so existing single-goal callers see byte-for-byte
 *   identical numbers.
 */
export async function computeGoalProgress(
  goalId: string,
  database: Db = db,
  overrideAttributedPlatformAmount?: number,
  portfolioShare?: number
): Promise<GoalProgress> {
  const goal = await getGoalById(goalId, database)
  if (!goal) {
    throw new GoalNotFoundError('Savings goal not found')
  }

  const targetAmount = Number(goal.targetAmount)
  const startingAmount = Number(goal.startingAmount)
  let requiredApy = calculateRequiredApy(
    startingAmount,
    targetAmount,
    calculateYearsRemaining(goal.targetDate)
  )

  let attributedPlatformAmount: number | undefined =
    overrideAttributedPlatformAmount
  if (attributedPlatformAmount === undefined) {
    const attributedMap = await getAttributedAmountsByGoalId(
      [goal.id],
      database
    )
    if (attributedMap && attributedMap.has(goal.id)) {
      attributedPlatformAmount = attributedMap.get(goal.id)!
    }
  }

  const extraFields = {
    ...(goal.priority !== undefined ? { priority: Number(goal.priority) } : {}),
    ...(goal.allocationWeight !== undefined
      ? { allocationWeight: Number(goal.allocationWeight) }
      : {}),
    ...(goal.fundingMode !== undefined
      ? { fundingMode: goal.fundingMode as GoalFundingMode }
      : {}),
    ...(portfolioShare !== undefined ? { portfolioShare } : {}),
  }

  if (goal.status !== 'ACTIVE') {
    const amounts = await resolveCurrentAmounts(
      goal.userId,
      goal.positionId,
      database,
      goal.includeExternalHoldings
    )
    const effectivePlatform =
      attributedPlatformAmount !== undefined
        ? attributedPlatformAmount
        : amounts.platformAmount
    const currentAmount = effectivePlatform + amounts.externalAmount
    return {
      goalId: goal.id,
      status: goal.status,
      targetAmount,
      startingAmount,
      currentAmount,
      targetDate: goal.targetDate.toISOString(),
      requiredApy: Number.isFinite(requiredApy) ? requiredApy : 0,
      actualApy: 0,
      onTrack: goal.status === 'ACHIEVED',
      reachable: goal.status === 'ACHIEVED',
      projectedCompletionDate: null,
      includeExternalHoldings: goal.includeExternalHoldings,
      externalStaleWalletCount: amounts.externalStaleWalletCount,
      unpricedExternalHoldingCount: amounts.unpricedExternalHoldingCount,
      ...extraFields,
    }
  }

  if (goal.positionId) {
    const position = await (database as any).position.findUnique({
      where: { id: goal.positionId },
    })
    if (!position || position.status !== 'ACTIVE') {
      await (database as any).savingsGoal.update({
        where: { id: goal.id },
        data: { status: 'CANCELLED' },
      })
      await logAgentAction(
        'GOAL_PROGRESS',
        'SKIPPED',
        { reasoning: 'Linked position is no longer active — goal cancelled' },
        goal.userId,
        goal.positionId
      )
      return computeGoalProgress(
        goalId,
        database,
        overrideAttributedPlatformAmount,
        portfolioShare
      )
    }
  }

  const amounts = await resolveCurrentAmounts(
    goal.userId,
    goal.positionId,
    database,
    goal.includeExternalHoldings
  )
  const effectivePlatformAmount =
    attributedPlatformAmount !== undefined
      ? attributedPlatformAmount
      : amounts.platformAmount
  const currentAmount = effectivePlatformAmount + amounts.externalAmount
  if (goal.includeExternalHoldings) {
    const managedTargetAmount = Math.max(
      0,
      targetAmount - amounts.externalAmount
    )
    requiredApy = calculateRequiredApy(
      effectivePlatformAmount,
      managedTargetAmount,
      calculateYearsRemaining(goal.targetDate)
    )
  } else if (
    attributedPlatformAmount !== undefined &&
    effectivePlatformAmount > 0
  ) {
    requiredApy = calculateRequiredApy(
      effectivePlatformAmount,
      targetAmount,
      calculateYearsRemaining(goal.targetDate)
    )
  }

  const actualApy = await resolveActualApy(goal.userId, database)
  const yearsRemaining = calculateYearsRemaining(goal.targetDate)

  if (currentAmount >= targetAmount) {
    await (database as any).savingsGoal.update({
      where: { id: goal.id },
      data: { status: 'ACHIEVED' },
    })
    await logAgentAction(
      'GOAL_PROGRESS',
      'SUCCESS',
      {
        reasoning: 'Savings goal achieved',
        outputData: { currentAmount, targetAmount },
      },
      goal.userId,
      goal.positionId ?? undefined
    )
    return {
      goalId: goal.id,
      status: 'ACHIEVED',
      targetAmount,
      startingAmount,
      currentAmount,
      targetDate: goal.targetDate.toISOString(),
      requiredApy: 0,
      actualApy,
      onTrack: true,
      reachable: true,
      projectedCompletionDate: new Date().toISOString(),
      includeExternalHoldings: goal.includeExternalHoldings,
      externalStaleWalletCount: amounts.externalStaleWalletCount,
      unpricedExternalHoldingCount: amounts.unpricedExternalHoldingCount,
      ...extraFields,
    }
  }

  if (yearsRemaining <= 0) {
    await (database as any).savingsGoal.update({
      where: { id: goal.id },
      data: { status: 'MISSED' },
    })
    await logAgentAction(
      'GOAL_PROGRESS',
      'FAILED',
      {
        reasoning: 'Savings goal target date passed without being met',
        outputData: { currentAmount, targetAmount },
      },
      goal.userId,
      goal.positionId ?? undefined
    )
    return {
      goalId: goal.id,
      status: 'MISSED',
      targetAmount,
      startingAmount,
      currentAmount,
      targetDate: goal.targetDate.toISOString(),
      requiredApy,
      actualApy,
      onTrack: false,
      reachable: false,
      projectedCompletionDate: null,
      includeExternalHoldings: goal.includeExternalHoldings,
      externalStaleWalletCount: amounts.externalStaleWalletCount,
      unpricedExternalHoldingCount: amounts.unpricedExternalHoldingCount,
      ...extraFields,
    }
  }

  const { reachable } = await resolveReachability(requiredApy, goal.riskCeiling)
  const onTrack = actualApy >= requiredApy

  let projectedCompletionDate: string | null = null
  const managedTargetAmount = goal.includeExternalHoldings
    ? Math.max(0, targetAmount - amounts.externalAmount)
    : targetAmount
  if (
    actualApy > 0 &&
    effectivePlatformAmount > 0 &&
    effectivePlatformAmount < managedTargetAmount
  ) {
    const yearsToComplete =
      (managedTargetAmount - effectivePlatformAmount) /
      effectivePlatformAmount /
      (actualApy / 100)
    const projected = new Date()
    projected.setDate(
      projected.getDate() + Math.round(yearsToComplete * 365.25)
    )
    projectedCompletionDate = projected.toISOString()
  }

  await logAgentAction(
    'GOAL_PROGRESS',
    'SUCCESS',
    {
      reasoning: reachable
        ? onTrack
          ? 'On track toward savings goal'
          : 'Behind schedule but still reachable within risk tolerance'
        : 'Target not reachable within your risk tolerance',
      outputData: {
        currentAmount,
        targetAmount,
        requiredApy,
        actualApy,
        reachable,
        onTrack,
      },
    },
    goal.userId,
    goal.positionId ?? undefined
  )

  const progressNotes = []
  if (!reachable) {
    progressNotes.push('Target not reachable within your risk tolerance')
  }
  if (goal.includeExternalHoldings) {
    progressNotes.push(
      'Includes unverified external snapshots; future returns on those assets are not modeled.'
    )
    if (amounts.externalStaleWalletCount > 0) {
      progressNotes.push(
        `${amounts.externalStaleWalletCount} external wallet snapshot(s) are stale.`
      )
    }
    if (amounts.unpricedExternalHoldingCount > 0) {
      progressNotes.push(
        `${amounts.unpricedExternalHoldingCount} unpriced external holding(s) are excluded.`
      )
    }
  }

  return {
    goalId: goal.id,
    status: goal.status,
    targetAmount,
    startingAmount,
    currentAmount,
    targetDate: goal.targetDate.toISOString(),
    requiredApy,
    actualApy,
    onTrack,
    reachable,
    projectedCompletionDate,
    includeExternalHoldings: goal.includeExternalHoldings,
    externalStaleWalletCount: amounts.externalStaleWalletCount,
    unpricedExternalHoldingCount: amounts.unpricedExternalHoldingCount,
    ...extraFields,
    note: progressNotes.length > 0 ? progressNotes.join(' ') : undefined,
  }
}

/**
 * List all goals for a user with per-goal `GoalProgress`, attributed
 * `currentAmount`, `portfolioShare`, and the user's `unallocated` remainder
 * (#358).
 */
export async function listGoalsWithProgress(
  userId: string,
  database: Db = db
): Promise<MultiGoalListResult> {
  const sgModel = (database as any).savingsGoal
  const rawGoals: any[] =
    typeof sgModel.findMany === 'function'
      ? await sgModel.findMany({ where: { userId } })
      : []

  const orderedGoals = sortGoalsByPriority(rawGoals)
  const portfolioAmounts = await resolveCurrentAmounts(
    userId,
    null,
    database,
    false
  )
  const totalPortfolioAmount = portfolioAmounts.platformAmount

  const attributedMap = await getAttributedAmountsByGoalId(
    orderedGoals.map((g) => g.id),
    database
  )

  const hasAnyLedgerRows = attributedMap !== null && attributedMap.size > 0
  const goalAttributedInputs = orderedGoals.map((g, idx) => {
    let attributedAmount = 0
    if (hasAnyLedgerRows) {
      attributedAmount = attributedMap!.get(g.id) ?? 0
    } else if (orderedGoals.length === 1 && idx === 0) {
      // Single-goal backward compatibility when no GoalAllocation rows exist yet
      attributedAmount = totalPortfolioAmount
    }
    return {
      id: g.id,
      attributedAmount,
    }
  })

  const reconciled = reconcileUserGoalAllocations({
    totalPortfolioAmount,
    goals: goalAttributedInputs,
  })
  const reconciledById = new Map(reconciled.goals.map((r) => [r.goalId, r]))

  let userFundingMode: GoalFundingMode = 'SEQUENTIAL'
  if (typeof (database as any).user?.findUnique === 'function') {
    const userRow = await (database as any).user.findUnique({
      where: { id: userId },
      select: { goalFundingMode: true },
    })
    if (userRow?.goalFundingMode === 'WEIGHTED') {
      userFundingMode = 'WEIGHTED'
    }
  }

  const items: MultiGoalListItem[] = []
  for (const goal of orderedGoals) {
    const rec = reconciledById.get(goal.id) ?? {
      goalId: goal.id,
      currentAmount: 0,
      portfolioShare: 0,
    }
    const progress = await computeGoalProgress(
      goal.id,
      database,
      hasAnyLedgerRows || orderedGoals.length > 1
        ? rec.currentAmount
        : undefined,
      rec.portfolioShare
    )
    items.push({
      goal,
      progress,
      currentAmount: progress.currentAmount,
      portfolioShare: rec.portfolioShare,
    })
  }

  return {
    goals: items,
    totalPortfolioAmount: reconciled.totalPortfolioAmount,
    totalAttributed: reconciled.totalAttributed,
    unallocated: reconciled.unallocated,
    goalFundingMode: userFundingMode,
  }
}
