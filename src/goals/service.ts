/**
 * Goal-based investing (#281) — business logic for SavingsGoal CRUD and
 * progress projection.
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
}

export interface UpdateGoalInput {
  targetAmount?: number
  targetDate?: Date
  riskCeiling?: number
  includeExternalHoldings?: boolean
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
  note?: string
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
 * Create a savings goal. Only one ACTIVE goal per user is allowed at a time
 * (enforced here at the API/service layer, not via a DB constraint, since past
 * goals are kept for history).
 *
 * When targetAmount is already met by the (possibly defaulted) starting
 * amount, the goal is created directly as ACHIEVED rather than a misleading
 * "in progress" ACTIVE record. Zod validation on the route already rejects an
 * explicitly-supplied startingAmount >= targetAmount before this runs.
 */
export async function createGoal(
  userId: string,
  input: CreateGoalInput,
  database: Db = db
): Promise<any> {
  const existingActive = await (database as any).savingsGoal.findFirst({
    where: { userId, status: 'ACTIVE' },
  })
  if (existingActive) {
    throw new GoalConflictError(
      'An active savings goal already exists for this user'
    )
  }

  const startingAmount =
    input.startingAmount ??
    (await resolveCurrentAmounts(userId, input.positionId, database))
      .platformAmount

  const status = input.targetAmount <= startingAmount ? 'ACHIEVED' : 'ACTIVE'

  const goal = await (database as any).savingsGoal.create({
    data: {
      userId,
      positionId: input.positionId ?? null,
      targetAmount: input.targetAmount,
      startingAmount,
      targetDate: input.targetDate,
      riskCeiling: input.riskCeiling ?? null,
      includeExternalHoldings: input.includeExternalHoldings ?? false,
      status,
    },
  })

  logger.info('Savings goal created', { userId, goalId: goal.id, status })

  return goal
}

/**
 * The user's current goal: their ACTIVE goal if one exists, otherwise their
 * most recently created goal (so a just-cancelled/achieved goal is still
 * visible), otherwise null.
 */
export async function getGoalForUser(
  userId: string,
  database: Db = db
): Promise<any | null> {
  const active = await (database as any).savingsGoal.findFirst({
    where: { userId, status: 'ACTIVE' },
  })
  if (active) return active

  return (database as any).savingsGoal.findFirst({
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
 * Update target amount/date/riskCeiling on an ACTIVE goal. Callers must check
 * ownership (goal.userId === req.auth.userId) before calling this — enforced
 * in the controller since this route is keyed by goal id, not :userId, so
 * enforceUserAccess doesn't apply.
 *
 * No recompute is stored here: yearsRemaining is always derived live from
 * targetDate at read time (see calculateYearsRemaining), so an edit to
 * targetDate/targetAmount is automatically reflected in the next progress
 * calculation without a separate "recompute" step.
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
 * Recent (30d) simple average APY across the user's active positions, mirroring
 * the averageApy calculation in routes/portfolio.ts's /earnings endpoint —
 * reused here rather than a second convention for "what rate am I actually
 * getting".
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
 * protocols and the goal's riskCeiling. Mirrors the same fail-closed
 * applyRiskCeiling filter GoalTrackingStrategy uses, so the agent and this
 * endpoint never disagree about what's reachable.
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
 * user's risk tolerance. Also lazily transitions the goal to ACHIEVED/MISSED
 * when appropriate, and logs an AgentLog GOAL_PROGRESS row so the trend is
 * inspectable the same way rebalance decisions already are.
 *
 * Note on linked positions: the codebase does not currently have a code path
 * that closes/liquidates a Position, so there is no event to hook a
 * goal-cancellation into. This is checked lazily here instead — if a goal's
 * linked position has disappeared or is no longer ACTIVE, the goal is
 * cancelled on next read rather than left dangling as ACTIVE.
 */
export async function computeGoalProgress(
  goalId: string,
  database: Db = db
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

  if (goal.status !== 'ACTIVE') {
    const amounts = await resolveCurrentAmounts(
      goal.userId,
      goal.positionId,
      database,
      goal.includeExternalHoldings
    )
    const currentAmount = amounts.platformAmount + amounts.externalAmount
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
      return computeGoalProgress(goalId, database)
    }
  }

  const amounts = await resolveCurrentAmounts(
    goal.userId,
    goal.positionId,
    database,
    goal.includeExternalHoldings
  )
  const currentAmount = amounts.platformAmount + amounts.externalAmount
  if (goal.includeExternalHoldings) {
    const managedTargetAmount = Math.max(
      0,
      targetAmount - amounts.externalAmount
    )
    requiredApy = calculateRequiredApy(
      amounts.platformAmount,
      managedTargetAmount,
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
    amounts.platformAmount > 0 &&
    amounts.platformAmount < managedTargetAmount
  ) {
    const yearsToComplete =
      (managedTargetAmount - amounts.platformAmount) /
      amounts.platformAmount /
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
    note: progressNotes.length > 0 ? progressNotes.join(' ') : undefined,
  }
}
