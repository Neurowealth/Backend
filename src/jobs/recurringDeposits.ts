import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { executeDeposit } from '../controllers/transaction-controller'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { addCadence } from '../utils/cadence'
import {
  computeContribution,
  computeNextRunAfterSkip,
  cadenceToDays,
  shouldAutoPause,
  AUTO_PAUSE_THRESHOLD,
  type SmartDcaConfig,
  type RegimeInput,
  type DrawdownInput,
  type ContributionDecision,
} from '../deposits/smartDcaPolicy'
import type { RecurringDepositPlan } from '@prisma/client'

export { addCadence } from '../utils/cadence'

/**
 * Attempt to atomically claim a due plan for execution.
 * Uses a conditional update so two overlapping job ticks cannot both
 * claim the same occurrence.
 *
 * Returns the claimed plan row if successful, null if already claimed.
 */
async function claimDuePlan(
  planId: string
): Promise<RecurringDepositPlan | null> {
  const now = new Date()

  // Find the plan first to get the current nextRunAt for comparison
  const plan = await db.recurringDepositPlan.findUnique({
    where: { id: planId },
  })

  if (
    !plan ||
    plan.status !== 'ACTIVE' ||
    plan.nextRunAt > now ||
    plan.lastRunStatus === 'executing'
  ) {
    return null
  }

  // Atomic claim: only succeed if the plan is still in the same state
  const updated = await db.recurringDepositPlan.updateMany({
    where: {
      id: planId,
      status: 'ACTIVE',
      nextRunAt: plan.nextRunAt,
      NOT: { lastRunStatus: 'executing' },
    },
    data: {
      lastRunAt: now,
      lastRunStatus: 'executing',
    },
  })

  if (updated.count === 0) {
    return null
  }

  // Re-fetch the updated row
  return db.recurringDepositPlan.findUnique({ where: { id: planId } })
}

/**
 * Load regime input for a user: trailing APY observations from ProtocolRate.
 * Returns null when insufficient history.
 */
async function loadRegimeInput(
  userId: string,
  now: Date
): Promise<RegimeInput | null> {
  const WINDOW_DAYS = 30
  const fromDate = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const rates = await db.protocolRate.findMany({
    where: { fetchedAt: { gte: fromDate } },
    select: { supplyApy: true },
    orderBy: { fetchedAt: 'asc' },
  })

  if (rates.length < 5) return null // Insufficient data

  return {
    recentValues: rates.map((r) => Number(r.supplyApy) * 100),
  }
}

/**
 * Load drawdown input for a user: current vs rolling 30-day peak.
 * Reuses the same pattern as alertRules.ts POSITION_DRAWDOWN.
 */
async function loadDrawdownInput(
  userId: string,
  now: Date
): Promise<DrawdownInput | null> {
  const positions = await db.position.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { id: true, currentValue: true },
  })

  if (positions.length === 0) return null

  const currentValue = positions.reduce(
    (sum, p) => sum + Number(p.currentValue),
    0
  )

  const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
  const fromDate = new Date(now.getTime() - WINDOW_MS)
  const snapshots = await db.yieldSnapshot.findMany({
    where: {
      positionId: { in: positions.map((p) => p.id) },
      snapshotAt: { gte: fromDate },
    },
    select: { principalAmount: true, yieldAmount: true, snapshotAt: true },
  })

  const valueByInstant = new Map<number, number>()
  for (const s of snapshots) {
    const key = s.snapshotAt.getTime()
    const v = Number(s.principalAmount) + Number(s.yieldAmount)
    valueByInstant.set(key, (valueByInstant.get(key) ?? 0) + v)
  }

  const historicalValues = Array.from(valueByInstant.values())
  const peakValue = Math.max(currentValue, ...historicalValues, 0)

  return { currentValue, peakValue }
}

/**
 * Create a run ledger row for the run record.
 */
async function createRunLedger(params: {
  planId: string
  userId: string
  baselineAmount: number
  appliedAmount: number
  regimeSnapshot: Record<string, unknown>
  reasoning: string
  status: 'EXECUTED' | 'SKIPPED' | 'FAILED' | 'PENDING_APPROVAL' | 'PARTIAL'
  txHash?: string
  errorMessage?: string
  allocationLegs?: unknown
}): Promise<void> {
  try {
    await db.recurringDepositRun.create({
      data: {
        planId: params.planId,
        userId: params.userId,
        baselineAmount: params.baselineAmount,
        appliedAmount: params.appliedAmount,
        regimeSnapshot: params.regimeSnapshot as any,
        reasoning: params.reasoning,
        status: params.status,
        txHash: params.txHash,
        errorMessage: params.errorMessage,
        allocationLegs: params.allocationLegs as any,
      },
    })
  } catch (err) {
    logger.error('[RecurringDeposit] Failed to create run ledger', {
      planId: params.planId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Execute a single recurring deposit plan.
 *
 * For ADAPTIVE plans, the contribution amount is computed by the policy
 * engine before deposit. The run ledger records every execution attempt.
 */
async function executePlan(plan: RecurringDepositPlan): Promise<void> {
  const now = new Date()

  // ── Resolve policy config from plan fields ──────────────────────────
  const policy = (plan as any).policy ?? 'FIXED'
  const config: SmartDcaConfig = {
    policy,
    catchUpMode: (plan as any).catchUpMode ?? 'RETRY',
    pauseOnDrawdownPct: (plan as any).pauseOnDrawdownPct ?? null,
    doubleOnDrawdown: (plan as any).doubleOnDrawdown ?? false,
    accumulatedRuns: (plan as any).accumulatedRuns ?? 0,
    consecutiveFailures: (plan as any).consecutiveFailures ?? 0,
    allocationMap:
      ((plan as any).allocationMap as Record<string, number> | null) ?? null,
  }

  // ── Auto-pause check ────────────────────────────────────────────────
  if (shouldAutoPause(config.consecutiveFailures)) {
    const reason = `Auto-paused after ${config.consecutiveFailures} consecutive failures`
    await db.recurringDepositPlan.update({
      where: { id: plan.id },
      data: {
        status: 'PAUSED',
        autoPauseReason: reason,
        lastRunStatus: 'auto_paused',
      },
    })
    await createRunLedger({
      planId: plan.id,
      userId: plan.userId,
      baselineAmount: Number(plan.amount),
      appliedAmount: 0,
      regimeSnapshot: {},
      reasoning: reason,
      status: 'SKIPPED',
    })
    logger.warn(
      '[RecurringDeposit] Plan auto-paused due to consecutive failures',
      {
        planId: plan.id,
        userId: plan.userId,
        failures: config.consecutiveFailures,
      }
    )
    return
  }

  // ── Load regime + drawdown data (ADAPTIVE plans only) ────────────────
  let regimeInput: RegimeInput | null = null
  let drawdownInput: DrawdownInput | null = null

  if (policy === 'ADAPTIVE') {
    regimeInput = await loadRegimeInput(plan.userId, now)
    drawdownInput = await loadDrawdownInput(plan.userId, now)
  }

  // ── Compute contribution via policy engine ──────────────────────────
  const decision = computeContribution(
    config,
    Number(plan.amount),
    regimeInput,
    drawdownInput,
    now
  )

  // ── Drawdown pause: skip and reschedule ─────────────────────────────
  if (decision.pausedOnDrawdown) {
    const cadenceDays = cadenceToDays(plan.cadence)
    const next = computeNextRunAfterSkip(
      config.catchUpMode,
      plan.nextRunAt,
      cadenceDays,
      config.accumulatedRuns
    )

    await db.recurringDepositPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'skipped_drawdown',
        nextRunAt: next.nextRunAt,
        accumulatedRuns: next.accumulatedRuns,
      },
    })
    await createRunLedger({
      planId: plan.id,
      userId: plan.userId,
      baselineAmount: decision.baselineAmount,
      appliedAmount: 0,
      regimeSnapshot: decision.regimeSnapshot,
      reasoning: decision.reasoning,
      status: 'SKIPPED',
    })

    logger.info('[RecurringDeposit] Run skipped — drawdown pause', {
      planId: plan.id,
      userId: plan.userId,
      reasoning: decision.reasoning,
    })
    return
  }

  // ── Zero-amount run (edge case) ─────────────────────────────────────
  if (decision.appliedAmount <= 0) {
    const cadenceDays = cadenceToDays(plan.cadence)
    const next = computeNextRunAfterSkip(
      config.catchUpMode,
      plan.nextRunAt,
      cadenceDays,
      config.accumulatedRuns
    )
    await db.recurringDepositPlan.update({
      where: { id: plan.id },
      data: {
        nextRunAt: next.nextRunAt,
        accumulatedRuns: next.accumulatedRuns,
      },
    })
    await createRunLedger({
      planId: plan.id,
      userId: plan.userId,
      baselineAmount: decision.baselineAmount,
      appliedAmount: 0,
      regimeSnapshot: decision.regimeSnapshot,
      reasoning: decision.reasoning + ' — zero amount, skipping',
      status: 'SKIPPED',
    })
    return
  }

  // ── Wallet check ────────────────────────────────────────────────────
  const wallet = await db.custodialWallet.findUnique({
    where: { userId: plan.userId },
    select: { publicKey: true },
  })

  if (!wallet) {
    logger.error('[RecurringDeposit] No wallet found for user', {
      planId: plan.id,
      userId: plan.userId,
    })
    await failPlan(plan, 'no_wallet', decision)
    return
  }

  // ── Execute deposit ─────────────────────────────────────────────────
  try {
    const result = await executeDeposit({
      userId: plan.userId,
      walletAddress: wallet.publicKey,
      amount: decision.appliedAmount,
      assetSymbol: plan.assetSymbol,
      memo: `recurring-deposit:${plan.id}`,
    })

    if (result.status === 'CONFIRMED') {
      const nextRunAt = addCadence(plan.cadence, now)
      await db.recurringDepositPlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'executed',
          nextRunAt,
          consecutiveFailures: 0, // Reset on success
          accumulatedRuns:
            config.catchUpMode === 'ACCUMULATE' ? 0 : config.accumulatedRuns,
        },
      })
      await createRunLedger({
        planId: plan.id,
        userId: plan.userId,
        baselineAmount: decision.baselineAmount,
        appliedAmount: decision.appliedAmount,
        regimeSnapshot: decision.regimeSnapshot,
        reasoning: decision.reasoning,
        status: 'EXECUTED',
        txHash: result.transaction!.txHash ?? undefined,
        allocationLegs:
          decision.allocationLegs.length > 0
            ? decision.allocationLegs
            : undefined,
      })

      logger.info('[RecurringDeposit] Plan executed successfully', {
        planId: plan.id,
        userId: plan.userId,
        baselineAmount: decision.baselineAmount,
        appliedAmount: decision.appliedAmount,
        txHash: result.transaction!.txHash,
      })

      publishUserEvent(
        plan.userId,
        EVENT_TYPE_TOPIC['recurring_deposit.executed'],
        'recurring_deposit.executed',
        {
          planId: plan.id,
          userId: plan.userId,
          amount: decision.appliedAmount,
          assetSymbol: plan.assetSymbol,
          cadence: plan.cadence,
          txHash: result.transaction!.txHash,
        }
      ).catch(() => {})
    } else if (result.status === 'PENDING_APPROVAL') {
      await db.recurringDepositPlan.update({
        where: { id: plan.id },
        data: { lastRunStatus: 'pending_approval' },
      })
      await createRunLedger({
        planId: plan.id,
        userId: plan.userId,
        baselineAmount: decision.baselineAmount,
        appliedAmount: decision.appliedAmount,
        regimeSnapshot: decision.regimeSnapshot,
        reasoning: decision.reasoning,
        status: 'PENDING_APPROVAL',
      })

      logger.info('[RecurringDeposit] Plan occurrence pending approval', {
        planId: plan.id,
        userId: plan.userId,
        approvalRequestId: result.approvalRequestId,
      })
    } else {
      await failPlan(plan, 'transaction_failed', decision)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error'
    const isInsufficientFunds =
      reason.toLowerCase().includes('insufficient') ||
      reason.toLowerCase().includes('balance')
    await failPlan(
      plan,
      isInsufficientFunds ? 'insufficient_funds' : reason,
      decision
    )
  }
}

/**
 * Mark a plan as failed and dispatch notifications.
 * Increments consecutiveFailures for backoff/auto-pause.
 */
async function failPlan(
  plan: RecurringDepositPlan,
  reason: string,
  decision?: ContributionDecision
): Promise<void> {
  const newFailureCount = ((plan as any).consecutiveFailures ?? 0) + 1

  await db.recurringDepositPlan.update({
    where: { id: plan.id },
    data: {
      lastRunStatus: reason,
      consecutiveFailures: newFailureCount,
    },
  })

  await createRunLedger({
    planId: plan.id,
    userId: plan.userId,
    baselineAmount: decision?.baselineAmount ?? Number(plan.amount),
    appliedAmount: 0,
    regimeSnapshot: decision?.regimeSnapshot ?? {},
    reasoning: `Failed: ${reason}`,
    status: 'FAILED',
    errorMessage: reason,
  })

  logger.warn('[RecurringDeposit] Plan execution failed', {
    planId: plan.id,
    userId: plan.userId,
    reason,
    consecutiveFailures: newFailureCount,
  })

  publishUserEvent(
    plan.userId,
    EVENT_TYPE_TOPIC['recurring_deposit.failed'],
    'recurring_deposit.failed',
    {
      planId: plan.id,
      userId: plan.userId,
      amount: decision?.appliedAmount ?? Number(plan.amount),
      assetSymbol: plan.assetSymbol,
      cadence: plan.cadence,
      reason,
    }
  ).catch(() => {})
}

/**
 * Process all recurring deposit plans that are due.
 */
export async function processRecurringDeposits(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'recurring_deposits'

    try {
      const now = new Date()
      const duePlans = await db.recurringDepositPlan.findMany({
        where: {
          status: 'ACTIVE',
          nextRunAt: { lte: now },
        },
        orderBy: { nextRunAt: 'asc' },
      })

      if (duePlans.length === 0) {
        const durationMs = Date.now() - startTime
        recordJobSuccess(jobName, durationMs)
        return
      }

      logBackgroundJob(
        jobName,
        'success',
        (Date.now() - startTime) / 1000,
        correlationId,
        {
          dueCount: duePlans.length,
        }
      )

      // Process each plan; failures are caught individually
      for (const plan of duePlans) {
        const claimed = await claimDuePlan(plan.id)
        if (!claimed) continue

        try {
          await executePlan(claimed)
        } catch (err) {
          logger.error('[RecurringDeposit] Unexpected error executing plan', {
            planId: plan.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      const durationMs = Date.now() - startTime
      recordBackgroundJob(jobName, 'success', durationMs / 1000)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - startTime
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', durationMs / 1000, correlationId, {
        error: errorMessage,
      })

      recordBackgroundJob(jobName, 'failed', durationMs / 1000)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Schedule the recurring deposit job to run once at startup, then
 * on a fixed interval (default: 5 minutes).
 *
 * @returns A NodeJS.Timeout handle (call clearInterval to stop it).
 */
export function scheduleRecurringDeposits(): NodeJS.Timeout {
  processRecurringDeposits()

  const handle = setInterval(
    processRecurringDeposits,
    config.recurringDeposits.intervalMs
  )

  logger.info(
    `[RecurringDeposit] Scheduler started (interval: ${config.recurringDeposits.intervalMs}ms)`
  )
  return handle
}
