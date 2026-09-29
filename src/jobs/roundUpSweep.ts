import db from '../db'
import { config } from '../config'
import { logger } from '../utils/logger'
import { executeDeposit } from '../controllers/transaction-controller'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { scheduleResilientJob } from './resilientScheduler'
import type { SweepExecutionResult } from '../roundup/types'

type Db = typeof db

export const ROUND_UP_SWEEP_EXECUTING_LEASE_MS = 10 * 60 * 1000

/**
 * Checks whether an EXECUTING accrual row has exceeded its lease duration.
 *
 * @param updatedAt - Timestamp of the last status update.
 * @param now - Current epoch timestamp in milliseconds.
 * @param leaseMs - Lease timeout in milliseconds.
 * @returns True if the lease has expired.
 */
export function isExecutingClaimStale(
  updatedAt: Date,
  now: number,
  leaseMs = ROUND_UP_SWEEP_EXECUTING_LEASE_MS
): boolean {
  return now - updatedAt.getTime() > leaseMs
}

/**
 * Claims eligible unswept accruals for a user atomically.
 *
 * @param userId - Unique user identifier.
 * @param minSweepAmount - Minimum accumulated total to trigger a sweep.
 * @param force - Whether to bypass the minimum threshold check.
 * @param database - Database client instance.
 * @returns List of claimed accrual records and total claimed amount.
 */
export async function claimEligibleAccruals(
  userId: string,
  minSweepAmount: number,
  force = false,
  database: Db = db
): Promise<{ accruals: any[]; totalAmount: number }> {
  const now = Date.now()
  const candidateAccruals = await (database as any).roundUpAccrual.findMany({
    where: {
      userId,
      OR: [
        { status: 'ACCRUED' },
        {
          status: 'EXECUTING',
          updatedAt: {
            lt: new Date(now - ROUND_UP_SWEEP_EXECUTING_LEASE_MS),
          },
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  if (!candidateAccruals || candidateAccruals.length === 0) {
    return { accruals: [], totalAmount: 0 }
  }

  const totalAmount = candidateAccruals.reduce((sum: number, item: any) => {
    const val =
      typeof item.totalRoundUp === 'object' &&
      item.totalRoundUp !== null &&
      'toNumber' in item.totalRoundUp
        ? item.totalRoundUp.toNumber()
        : Number(item.totalRoundUp)
    return sum + val
  }, 0)

  const roundedTotal = Math.round(totalAmount * 100) / 100

  if (!force && roundedTotal < minSweepAmount) {
    return { accruals: [], totalAmount: 0 }
  }

  const ids = candidateAccruals.map((a: any) => a.id)
  await (database as any).roundUpAccrual.updateMany({
    where: {
      id: { in: ids },
    },
    data: {
      status: 'EXECUTING',
      updatedAt: new Date(now),
    },
  })

  return { accruals: candidateAccruals, totalAmount: roundedTotal }
}

/**
 * Executes a sweep of accumulated round-ups into an on-chain deposit.
 *
 * @param userId - Unique user identifier.
 * @param force - Whether to bypass the minimum threshold check.
 * @param database - Database client instance.
 * @returns Result summary of the sweep operation.
 */
export async function executeUserSweep(
  userId: string,
  force = false,
  database: Db = db
): Promise<SweepExecutionResult> {
  const minSweepAmount = config.roundUp?.minSweepAmount ?? 5.0
  const { accruals, totalAmount } = await claimEligibleAccruals(
    userId,
    minSweepAmount,
    force,
    database
  )

  if (accruals.length === 0) {
    return {
      userId,
      totalSwept: 0,
      accrualCount: 0,
      status: 'SKIPPED_THRESHOLD',
    }
  }

  const settings = await (database as any).roundUpSettings.findUnique({
    where: { userId },
  })

  let targetGoalId = settings?.targetGoalId ?? null
  if (targetGoalId) {
    const goal = await (database as any).savingsGoal.findUnique({
      where: { id: targetGoalId },
    })
    if (!goal || goal.status !== 'ACTIVE') {
      logger.warn(
        '[RoundUpSweep] Target goal missing or inactive; falling back to default strategy',
        { userId, targetGoalId }
      )
      targetGoalId = null
    }
  }

  const wallet = await (database as any).custodialWallet.findUnique({
    where: { userId },
    select: { publicKey: true },
  })

  let walletAddress = wallet?.publicKey
  if (!walletAddress) {
    const user = await (database as any).user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    })
    walletAddress = user?.walletAddress
  }

  if (!walletAddress) {
    logger.error('[RoundUpSweep] No wallet found for user', { userId })
    const ids = accruals.map((a: any) => a.id)
    await (database as any).roundUpAccrual.updateMany({
      where: { id: { in: ids } },
      data: { status: 'ACCRUED' },
    })
    return {
      userId,
      totalSwept: 0,
      accrualCount: accruals.length,
      status: 'NO_WALLET',
      error: 'User has no wallet address',
    }
  }

  const assetSymbol = config.roundUp?.assetSymbol ?? 'USDC'
  const memo = targetGoalId
    ? `round-up:goal:${targetGoalId}`
    : `round-up:sweep:${userId}`

  try {
    const result = await executeDeposit({
      userId,
      walletAddress,
      amount: totalAmount,
      assetSymbol,
      memo,
    })

    if (result.status === 'CONFIRMED' || (result.transaction && result.status !== 'FAILED')) {
      const ids = accruals.map((a: any) => a.id)
      const sweptAt = new Date()
      const txId = result.transaction?.id ?? null

      await (database as any).roundUpAccrual.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'SWEPT',
          sweptAt,
          sweepTransactionId: txId,
        },
      })

      logger.info('[RoundUpSweep] Sweep successfully deposited', {
        userId,
        amount: totalAmount,
        accrualCount: accruals.length,
        transactionId: txId,
        targetGoalId,
      })

      publishUserEvent(
        userId,
        EVENT_TYPE_TOPIC['round_up.swept'],
        'round_up.swept',
        {
          userId,
          amount: totalAmount,
          accrualCount: accruals.length,
          transactionId: txId,
          targetGoalId,
          sweptAt: sweptAt.toISOString(),
        }
      ).catch(() => {})

      return {
        userId,
        totalSwept: totalAmount,
        accrualCount: accruals.length,
        status: 'SWEPT',
        transactionId: txId ?? undefined,
        targetGoalId,
      }
    }

    if (result.status === 'PENDING_APPROVAL') {
      logger.info('[RoundUpSweep] Sweep held for approval', {
        userId,
        approvalRequestId: result.approvalRequestId,
      })
      return {
        userId,
        totalSwept: totalAmount,
        accrualCount: accruals.length,
        status: 'PENDING_APPROVAL',
      }
    }

    const ids = accruals.map((a: any) => a.id)
    await (database as any).roundUpAccrual.updateMany({
      where: { id: { in: ids } },
      data: { status: 'ACCRUED' },
    })

    return {
      userId,
      totalSwept: 0,
      accrualCount: accruals.length,
      status: 'FAILED',
      error: `Deposit status: ${result.status}`,
    }
  } catch (error: any) {
    logger.error('[RoundUpSweep] Deposit failed with error', {
      userId,
      error: error?.message,
    })

    const ids = accruals.map((a: any) => a.id)
    await (database as any).roundUpAccrual.updateMany({
      where: { id: { in: ids } },
      data: { status: 'ACCRUED' },
    })

    return {
      userId,
      totalSwept: 0,
      accrualCount: accruals.length,
      status: 'FAILED',
      error: error?.message ?? 'Execution error',
    }
  }
}

/**
 * Batch processor for sweeping eligible round-ups across all users.
 *
 * @param database - Database client instance.
 * @returns Summary counts of swept, skipped, and failed users.
 */
export async function processRoundUpSweeps(
  database: Db = db
): Promise<{ sweptCount: number; skippedCount: number; failedCount: number }> {
  const candidates = await (database as any).roundUpAccrual.findMany({
    where: { status: 'ACCRUED' },
    select: { userId: true },
    distinct: ['userId'],
  })

  let sweptCount = 0
  let skippedCount = 0
  let failedCount = 0

  for (const candidate of candidates) {
    try {
      const res = await executeUserSweep(candidate.userId, false, database)
      if (res.status === 'SWEPT') {
        sweptCount++
      } else if (res.status === 'SKIPPED_THRESHOLD') {
        skippedCount++
      } else {
        failedCount++
      }
    } catch (err: any) {
      failedCount++
      logger.error('[RoundUpSweep] Error processing candidate sweep', {
        userId: candidate.userId,
        error: err?.message,
      })
    }
  }

  return { sweptCount, skippedCount, failedCount }
}

/**
 * Initializes and schedules the resilient background job for round-up sweeping.
 *
 * @returns A NodeJS.Timeout handle.
 */
export function scheduleRoundUpSweep(): NodeJS.Timeout {
  const intervalMs = config.roundUp?.sweepIntervalMs ?? 300000
  const handle = scheduleResilientJob({
    jobName: 'round_up_sweep',
    task: async () => {
      await processRoundUpSweeps()
    },
    intervalMs,
  })

  logger.info(
    `[RoundUpSweep] Scheduler started (interval: ${intervalMs}ms)`
  )
  return handle
}
