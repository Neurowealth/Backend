import { RecurringWithdrawalPlan } from '@prisma/client'
import db from '../db'
import { executeWithdraw } from '../controllers/transaction-controller'
import { isUserHalted } from '../outbox/service'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { logger, logBackgroundJob } from '../utils/logger'
import { config } from '../config/env'
import { addCadence } from '../utils/cadence'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'

export const RECURRING_WITHDRAWAL_EXECUTING_LEASE_MS = 5 * 60 * 1000

/**
 * Check if a destination address has prior confirmed history for this user.
 *
 * @param userId Target user ID.
 * @param destinationAddress Destination address to verify.
 * @returns True if destination is known.
 */
export async function isKnownDestinationAddress(
  userId: string,
  destinationAddress: string
): Promise<boolean> {
  const confirmedPlan = await db.recurringWithdrawalPlan.findFirst({
    where: {
      userId,
      destinationAddress,
      lastRunStatus: 'executed',
    },
  })
  if (confirmedPlan) return true

  const priorOps = await db.outboxOp.findMany({
    where: {
      userId,
      kind: 'WITHDRAW',
      status: 'CONFIRMED',
    },
    take: 50,
    select: { payload: true },
  })

  return priorOps.some((op) => {
    const p = op.payload as Record<string, unknown> | null
    return (
      p?.userAddress === destinationAddress ||
      p?.destination === destinationAddress
    )
  })
}

/**
 * Check if an in-progress executing claim has expired past the lease window.
 *
 * @param plan The recurring withdrawal plan to evaluate.
 * @param now Reference timestamp.
 * @returns True if lease is stale.
 */
export function isExecutingClaimStale(
  plan: RecurringWithdrawalPlan,
  now: Date
): boolean {
  if (!plan.lastRunAt) return true
  return (
    now.getTime() - plan.lastRunAt.getTime() >
    RECURRING_WITHDRAWAL_EXECUTING_LEASE_MS
  )
}

/**
 * Atomically claim a due plan for execution to prevent concurrent executions.
 *
 * @param planId Identifier of the plan.
 * @returns The claimed plan or null if contention occurred.
 */
export async function claimDuePlan(
  planId: string
): Promise<RecurringWithdrawalPlan | null> {
  const now = new Date()
  const plan = await db.recurringWithdrawalPlan.findUnique({
    where: { id: planId },
  })

  const staleExecuting = !!plan && isExecutingClaimStale(plan, now)

  if (
    !plan ||
    plan.status !== 'ACTIVE' ||
    plan.nextRunAt > now ||
    (plan.lastRunStatus === 'executing' && !staleExecuting)
  ) {
    return null
  }

  const updated = await db.recurringWithdrawalPlan.updateMany({
    where: {
      id: planId,
      status: 'ACTIVE',
      nextRunAt: plan.nextRunAt,
      ...(staleExecuting
        ? { lastRunStatus: 'executing' }
        : { NOT: { lastRunStatus: 'executing' } }),
    },
    data: {
      lastRunAt: now,
      lastRunStatus: 'executing',
    },
  })

  if (updated.count === 0) {
    return null
  }

  return db.recurringWithdrawalPlan.findUnique({ where: { id: planId } })
}

type ResumeDecision = 'completed' | 'in_flight' | 'retry'

/**
 * Evaluate interrupted plan occurrence following crash recovery.
 *
 * @param plan The interrupted recurring withdrawal plan.
 * @returns Resolution decision for the plan.
 */
async function resumeInterruptedPlan(
  plan: RecurringWithdrawalPlan
): Promise<ResumeDecision> {
  const since = plan.lastRunAt ?? new Date(0)
  const existing = await db.transaction.findFirst({
    where: {
      userId: plan.userId,
      type: 'WITHDRAWAL',
      memo: `recurring-withdrawal:${plan.id}`,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!existing) return 'retry'

  if (existing.status === 'CONFIRMED') {
    await db.recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'executed',
        nextRunAt: addCadence(plan.cadence, new Date()),
      },
    })
    logger.info(
      '[RecurringWithdrawal] Resumed interrupted plan from confirmed transaction',
      { planId: plan.id, transactionId: existing.id }
    )
    return 'completed'
  }

  if (existing.status === 'PENDING') {
    logger.warn(
      '[RecurringWithdrawal] Interrupted plan has a pending withdrawal; waiting for outbox',
      { planId: plan.id, transactionId: existing.id }
    )
    return 'in_flight'
  }

  return 'retry'
}

/**
 * Execute a single recurring withdrawal plan with full compliance and guardrail checks.
 *
 * @param plan The claimed recurring withdrawal plan.
 */
export async function executePlan(
  plan: RecurringWithdrawalPlan
): Promise<void> {
  const halted = await isUserHalted(plan.userId)
  if (halted) {
    await db.recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        status: 'PAUSED',
        lastRunStatus: 'compliance_halted',
      },
    })
    logger.warn(
      '[RecurringWithdrawal] User is halted by compliance; plan paused',
      {
        planId: plan.id,
        userId: plan.userId,
      }
    )
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['recurring_withdrawal.held'],
      'recurring_withdrawal.held',
      {
        planId: plan.id,
        reason: 'Account is frozen by compliance. Plan paused.',
      }
    ).catch(() => {})
    return
  }

  const positions = await db.position.findMany({
    where: {
      userId: plan.userId,
      assetSymbol: plan.assetSymbol,
      status: 'ACTIVE',
    },
  })
  const totalBalance = positions.reduce(
    (sum, p) => sum + Number(p.currentValue),
    0
  )
  const totalYield = positions.reduce(
    (sum, p) => sum + Number(p.yieldEarned),
    0
  )

  let targetAmount = 0
  if (plan.amountMode === 'FIXED') {
    targetAmount = Number(plan.amountValue ?? plan.amount ?? 0)
  } else if (plan.amountMode === 'PERCENT_OF_BALANCE') {
    const pct = Number(plan.amountValue ?? plan.amount ?? 0)
    const ratio = pct > 1 ? pct / 100 : pct
    targetAmount = Math.max(0, totalBalance * ratio)
  } else if (plan.amountMode === 'YIELD_ONLY') {
    targetAmount = Math.max(0, totalYield)
  }

  let resolvedAmount = targetAmount
  const minThreshold = plan.minAmount != null ? Number(plan.minAmount) : 0

  if (plan.amountMode === 'FIXED' && totalBalance < targetAmount) {
    if (minThreshold > 0 && totalBalance >= minThreshold) {
      resolvedAmount = totalBalance
    } else {
      await db.recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'skipped_insufficient_funds',
          nextRunAt: addCadence(plan.cadence, new Date()),
        },
      })
      logger.info(
        '[RecurringWithdrawal] Plan skipped due to insufficient funds; rolled to next cadence',
        { planId: plan.id, userId: plan.userId, totalBalance, targetAmount }
      )
      publishUserEvent(
        plan.userId,
        EVENT_TYPE_TOPIC['recurring_withdrawal.skipped'],
        'recurring_withdrawal.skipped',
        {
          planId: plan.id,
          reason: 'Insufficient balance to satisfy withdrawal',
          balance: totalBalance,
          requested: targetAmount,
        }
      ).catch(() => {})
      return
    }
  }

  if (minThreshold > 0 && resolvedAmount < minThreshold) {
    await db.recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'skipped_below_min',
        nextRunAt: addCadence(plan.cadence, new Date()),
      },
    })
    logger.info(
      '[RecurringWithdrawal] Plan skipped below minimum threshold; rolled to next cadence',
      {
        planId: plan.id,
        userId: plan.userId,
        resolvedAmount,
        minAmount: minThreshold,
      }
    )
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['recurring_withdrawal.skipped'],
      'recurring_withdrawal.skipped',
      {
        planId: plan.id,
        reason: 'Resolved amount below configured minimum',
        resolvedAmount,
        minAmount: minThreshold,
      }
    ).catch(() => {})
    return
  }

  if (resolvedAmount <= 0) {
    await db.recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'skipped_zero_amount',
        nextRunAt: addCadence(plan.cadence, new Date()),
      },
    })
    return
  }

  const activeGoal = await db.savingsGoal.findFirst({
    where: { userId: plan.userId, status: 'ACTIVE' },
  })
  if (activeGoal) {
    let currentGoalAmount = totalBalance
    if (activeGoal.positionId) {
      const pos = await db.position.findUnique({
        where: { id: activeGoal.positionId },
      })
      if (pos && pos.userId === plan.userId) {
        currentGoalAmount = Number(pos.currentValue)
      }
    }
    const target = Number(activeGoal.targetAmount)
    if (currentGoalAmount - resolvedAmount < target) {
      await db.recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'held_goal_conflict',
        },
      })
      logger.warn(
        '[RecurringWithdrawal] Run held due to goal guardrail conflict',
        {
          planId: plan.id,
          userId: plan.userId,
          goalId: activeGoal.id,
          currentGoalAmount,
          targetAmount: target,
          resolvedAmount,
        }
      )
      publishUserEvent(
        plan.userId,
        EVENT_TYPE_TOPIC['recurring_withdrawal.held'],
        'recurring_withdrawal.held',
        {
          planId: plan.id,
          reason:
            'Withdrawal would compromise active savings goal. Review required.',
          goalId: activeGoal.id,
          resolvedAmount,
          targetAmount: target,
        }
      ).catch(() => {})
      return
    }
  }

  const isKnown = await isKnownDestinationAddress(
    plan.userId,
    plan.destinationAddress
  )
  if (!isKnown) {
    await db.recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'held_new_destination',
      },
    })
    logger.warn(
      '[RecurringWithdrawal] Run held due to unverified new destination',
      {
        planId: plan.id,
        userId: plan.userId,
        destinationAddress: plan.destinationAddress,
      }
    )
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['recurring_withdrawal.held'],
      'recurring_withdrawal.held',
      {
        planId: plan.id,
        reason:
          'New destination address requires verification before automated execution.',
        destinationAddress: plan.destinationAddress,
        resolvedAmount,
      }
    ).catch(() => {})
    return
  }

  try {
    const result = await executeWithdraw({
      userId: plan.userId,
      walletAddress: plan.destinationAddress,
      amount: resolvedAmount,
      assetSymbol: plan.assetSymbol,
      memo: `recurring-withdrawal:${plan.id}`,
    })

    if (result.status === 'CONFIRMED') {
      const nextRunAt = addCadence(plan.cadence, new Date())
      await db.recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'executed',
          nextRunAt,
        },
      })

      logger.info('[RecurringWithdrawal] Plan executed successfully', {
        planId: plan.id,
        userId: plan.userId,
        txHash: result.transaction?.txHash,
      })

      publishUserEvent(
        plan.userId,
        EVENT_TYPE_TOPIC['recurring_withdrawal.executed'],
        'recurring_withdrawal.executed',
        {
          planId: plan.id,
          userId: plan.userId,
          amount: resolvedAmount,
          assetSymbol: plan.assetSymbol,
          cadence: plan.cadence,
          destinationAddress: plan.destinationAddress,
          txHash: result.transaction?.txHash,
        }
      ).catch(() => {})
    } else if (result.status === 'PENDING_APPROVAL') {
      await db.recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: { lastRunStatus: 'pending_approval' },
      })

      logger.info('[RecurringWithdrawal] Plan occurrence pending approval', {
        planId: plan.id,
        userId: plan.userId,
        approvalRequestId: result.approvalRequestId,
      })

      publishUserEvent(
        plan.userId,
        EVENT_TYPE_TOPIC['recurring_withdrawal.held'],
        'recurring_withdrawal.held',
        {
          planId: plan.id,
          reason: 'High-value withdrawal requires approval.',
          approvalRequestId: result.approvalRequestId,
        }
      ).catch(() => {})
    } else if (result.status === 'PENDING') {
      const nextRunAt = addCadence(plan.cadence, new Date())
      await db.recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'pending',
          nextRunAt,
        },
      })
    } else {
      await failPlan(plan, 'transaction_failed', resolvedAmount)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error'
    const isInsufficient =
      reason.toLowerCase().includes('insufficient') ||
      reason.toLowerCase().includes('balance')

    await failPlan(
      plan,
      isInsufficient ? 'insufficient_funds' : reason,
      resolvedAmount
    )
  }
}

/**
 * Mark a plan occurrence as failed and dispatch notification event.
 *
 * @param plan The affected plan.
 * @param reason Error rationale string.
 * @param amount Attempted withdrawal amount.
 */
async function failPlan(
  plan: RecurringWithdrawalPlan,
  reason: string,
  amount?: number
): Promise<void> {
  await db.recurringWithdrawalPlan.update({
    where: { id: plan.id },
    data: { lastRunStatus: reason },
  })

  logger.warn('[RecurringWithdrawal] Plan execution failed', {
    planId: plan.id,
    userId: plan.userId,
    reason,
  })

  publishUserEvent(
    plan.userId,
    EVENT_TYPE_TOPIC['recurring_withdrawal.failed'],
    'recurring_withdrawal.failed',
    {
      planId: plan.id,
      userId: plan.userId,
      amount: amount ?? Number(plan.amountValue ?? plan.amount ?? 0),
      assetSymbol: plan.assetSymbol,
      cadence: plan.cadence,
      destinationAddress: plan.destinationAddress,
      reason,
    }
  ).catch(() => {})
}

/**
 * Sweep and execute all due recurring withdrawal plans.
 */
export async function processRecurringWithdrawals(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'recurring_withdrawals'

    try {
      const now = new Date()
      const duePlans = await db.recurringWithdrawalPlan.findMany({
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

      for (const plan of duePlans) {
        if (plan.lastRunStatus === 'executing') {
          if (!isExecutingClaimStale(plan, now)) continue
          const decision = await resumeInterruptedPlan(plan)
          if (decision !== 'retry') continue
        }

        const claimed = await claimDuePlan(plan.id)
        if (!claimed) continue

        try {
          await executePlan(claimed)
        } catch (err) {
          logger.error(
            '[RecurringWithdrawal] Unexpected error executing plan',
            {
              planId: plan.id,
              error: err instanceof Error ? err.message : String(err),
            }
          )
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
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

/**
 * Schedule the recurring withdrawal job to run at startup and periodic interval.
 *
 * @returns Timeout handle for scheduler lifecycle management.
 */
export function scheduleRecurringWithdrawals(): NodeJS.Timeout {
  const handle = scheduleResilientJob({
    jobName: 'recurring_withdrawals',
    task: processRecurringWithdrawals,
    intervalMs: config.recurringWithdrawals.intervalMs,
  })

  logger.info(
    `[RecurringWithdrawal] Scheduler started (interval: ${config.recurringWithdrawals.intervalMs}ms)`
  )
  return handle
}
