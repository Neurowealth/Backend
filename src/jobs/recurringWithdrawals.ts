import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import { executeWithdraw } from '../controllers/transaction-controller'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { addCadence } from '../utils/cadence'

export { addCadence } from '../utils/cadence'

export interface RecurringWithdrawalPlan {
  id: string
  userId: string
  destinationAddress: string
  assetSymbol: string
  amountMode: 'FIXED' | 'YIELD_ONLY' | 'PERCENT_OF_BALANCE'
  amount: any
  percentage: any
  cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
  nextRunAt: Date
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED'
  minAmount: any
  lastRunAt: Date | null
  lastRunStatus: string | null
  createdAt: Date
  updatedAt: Date
}

export const RECURRING_WITHDRAWAL_EXECUTING_LEASE_MS = 10 * 60 * 1000

export function isExecutingClaimStale(
  plan: { lastRunStatus: string | null; lastRunAt: Date | null },
  now: Date = new Date(),
  leaseMs = RECURRING_WITHDRAWAL_EXECUTING_LEASE_MS
): boolean {
  if (plan.lastRunStatus !== 'executing') return false
  if (!plan.lastRunAt) return true
  return now.getTime() - new Date(plan.lastRunAt).getTime() >= leaseMs
}

async function claimDuePlan(
  planId: string
): Promise<RecurringWithdrawalPlan | null> {
  const now = new Date()

  const plan = await (db as any).recurringWithdrawalPlan.findUnique({
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

  const updated = await (db as any).recurringWithdrawalPlan.updateMany({
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

  return (db as any).recurringWithdrawalPlan.findUnique({ where: { id: planId } })
}

export async function resolveWithdrawalAmount(
  plan: RecurringWithdrawalPlan
): Promise<{ amount: number; reason?: string }> {
  if (plan.amountMode === 'FIXED') {
    const amt = plan.amount ? Number(plan.amount) : 0
    return { amount: amt }
  }

  const positions = await db.position.findMany({
    where: {
      userId: plan.userId,
      assetSymbol: plan.assetSymbol,
      status: 'ACTIVE',
    },
  })

  const totalValue = positions.reduce(
    (sum: number, p: any) => sum + Number(p.currentValue),
    0
  )
  const totalYield = positions.reduce(
    (sum: number, p: any) => sum + Number(p.yieldEarned),
    0
  )

  if (plan.amountMode === 'YIELD_ONLY') {
    if (totalYield <= 0) {
      return { amount: 0, reason: 'insufficient_yield' }
    }
    return { amount: totalYield }
  }

  if (plan.amountMode === 'PERCENT_OF_BALANCE') {
    const pct = plan.percentage ? Number(plan.percentage) : 0
    if (totalValue <= 0 || pct <= 0) {
      return { amount: 0, reason: 'insufficient_balance' }
    }
    const calculated = (totalValue * pct) / 100
    return { amount: calculated }
  }

  return { amount: plan.amount ? Number(plan.amount) : 0 }
}

export async function checkDestinationRisk(
  userId: string,
  destinationAddress: string
): Promise<{ isRisk: boolean; reason?: string }> {
  const priorTx = await db.transaction.findFirst({
    where: {
      userId,
      memo: { contains: destinationAddress },
    },
  })

  const linkedWallet = await db.linkedExternalWallet.findFirst({
    where: { userId, publicKey: destinationAddress },
  })

  const activeCase = await db.complianceCase.findFirst({
    where: {
      userId,
      status: { in: ['OPEN', 'INVESTIGATING', 'ESCALATED'] },
    },
  })

  if (activeCase) {
    return {
      isRisk: true,
      reason: 'compliance_freeze_active_case',
    }
  }

  if (!priorTx && !linkedWallet) {
    return {
      isRisk: true,
      reason: 'new_destination_unverified',
    }
  }

  return { isRisk: false }
}

export async function checkGoalGuardrailConflict(
  userId: string,
  assetSymbol: string,
  withdrawAmount: number
): Promise<{ conflict: boolean; reason?: string }> {
  const activeGoals = await db.savingsGoal.findMany({
    where: {
      userId,
      status: 'ACTIVE',
    },
  })

  if (activeGoals.length === 0) {
    return { conflict: false }
  }

  const positions = await db.position.findMany({
    where: {
      userId,
      assetSymbol,
      status: 'ACTIVE',
    },
  })

  const currentTotal = positions.reduce(
    (sum: number, p: any) => sum + Number(p.currentValue),
    0
  )
  const remainingTotal = currentTotal - withdrawAmount

  for (const goal of activeGoals) {
    const target = Number(goal.targetAmount)
    if (remainingTotal < target) {
      return {
        conflict: true,
        reason: `Withdrawal would drop balance (${remainingTotal.toFixed(
          2
        )}) below active goal target (${target.toFixed(2)})`,
      }
    }
  }

  return { conflict: false }
}

async function executePlan(plan: RecurringWithdrawalPlan): Promise<void> {
  const nextRunAt = addCadence(plan.cadence, new Date())

  const { amount, reason: resolveReason } = await resolveWithdrawalAmount(plan)
  const minAmt = plan.minAmount ? Number(plan.minAmount) : 0

  if (amount <= 0 || (minAmt > 0 && amount < minAmt)) {
    const skipReason = resolveReason ?? 'below_min_amount'
    await (db as any).recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: `skipped:${skipReason}`,
        nextRunAt,
      },
    })

    logger.info(
      '[RecurringWithdrawal] Plan skipped and rolled to next run date',
      {
        planId: plan.id,
        userId: plan.userId,
        resolvedAmount: amount,
        minAmount: minAmt,
        reason: skipReason,
      }
    )

    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['recurring_deposit.failed'],
      'recurring_deposit.failed',
      {
        planId: plan.id,
        userId: plan.userId,
        amount,
        minAmount: minAmt,
        reason: skipReason,
      }
    ).catch(() => {})
    return
  }

  const riskCheck = await checkDestinationRisk(
    plan.userId,
    plan.destinationAddress
  )
  if (riskCheck.isRisk) {
    await (db as any).recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: `held_risk:${riskCheck.reason}`,
        nextRunAt,
      },
    })

    logger.warn('[RecurringWithdrawal] Plan held due to compliance risk', {
      planId: plan.id,
      userId: plan.userId,
      reason: riskCheck.reason,
    })

    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['recurring_deposit.failed'],
      'recurring_deposit.failed',
      {
        planId: plan.id,
        userId: plan.userId,
        destinationAddress: plan.destinationAddress,
        reason: riskCheck.reason,
      }
    ).catch(() => {})
    return
  }

  const goalCheck = await checkGoalGuardrailConflict(
    plan.userId,
    plan.assetSymbol,
    amount
  )
  if (goalCheck.conflict) {
    await (db as any).recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: `held_guardrail:${goalCheck.reason}`,
        nextRunAt,
      },
    })

    logger.warn('[RecurringWithdrawal] Plan held due to goal guardrail conflict', {
      planId: plan.id,
      userId: plan.userId,
      reason: goalCheck.reason,
    })

    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['recurring_deposit.failed'],
      'recurring_deposit.failed',
      {
        planId: plan.id,
        userId: plan.userId,
        reason: goalCheck.reason,
      }
    ).catch(() => {})
    return
  }

  try {
    const result = await executeWithdraw({
      userId: plan.userId,
      walletAddress: plan.destinationAddress,
      amount,
      assetSymbol: plan.assetSymbol,
      memo: `recurring-withdrawal:${plan.id}`,
    })

    if (result.status === 'CONFIRMED' || result.status === 'PENDING') {
      await (db as any).recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'executed',
          nextRunAt,
        },
      })

      logger.info('[RecurringWithdrawal] Plan executed successfully', {
        planId: plan.id,
        userId: plan.userId,
        amount,
        status: result.status,
      })

      publishUserEvent(
        plan.userId,
        EVENT_TYPE_TOPIC['recurring_deposit.executed'],
        'recurring_deposit.executed',
        {
          planId: plan.id,
          userId: plan.userId,
          amount,
          assetSymbol: plan.assetSymbol,
          cadence: plan.cadence,
          txHash: result.transaction?.txHash,
        }
      ).catch(() => {})
    } else if (result.status === 'PENDING_APPROVAL') {
      await (db as any).recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: { lastRunStatus: 'pending_approval' },
      })

      logger.info('[RecurringWithdrawal] Plan occurrence pending approval', {
        planId: plan.id,
        userId: plan.userId,
        approvalRequestId: result.approvalRequestId,
      })
    } else {
      await (db as any).recurringWithdrawalPlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'transaction_failed',
          nextRunAt,
        },
      })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error'
    const isInsufficient =
      reason.toLowerCase().includes('insufficient') ||
      reason.toLowerCase().includes('balance')

    await (db as any).recurringWithdrawalPlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: isInsufficient ? 'skipped:insufficient_balance' : reason,
        nextRunAt,
      },
    })

    logger.warn('[RecurringWithdrawal] Plan execution failed or skipped', {
      planId: plan.id,
      userId: plan.userId,
      reason,
    })
  }
}

export async function processRecurringWithdrawals(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'recurring_withdrawals'

    try {
      const now = new Date()
      const duePlans = await (db as any).recurringWithdrawalPlan.findMany({
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
        { dueCount: duePlans.length }
      )

      for (const plan of duePlans) {
        if (plan.lastRunStatus === 'executing') {
          if (!isExecutingClaimStale(plan, now)) continue
        }

        const claimed = await claimDuePlan(plan.id)
        if (!claimed) continue

        try {
          await executePlan(claimed)
        } catch (err) {
          logger.error('[RecurringWithdrawal] Unexpected error executing plan', {
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
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

export function scheduleRecurringWithdrawals(): NodeJS.Timeout {
  const intervalMs = config.recurringDeposits?.intervalMs ?? 5 * 60 * 1000
  const handle = scheduleResilientJob({
    jobName: 'recurring_withdrawals',
    task: processRecurringWithdrawals,
    intervalMs,
  })

  logger.info(
    `[RecurringWithdrawal] Scheduler started (interval: ${intervalMs}ms)`
  )
  return handle
}
