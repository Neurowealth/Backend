/**
 * Liquidation monitor (#532) — the job that decides a loan has to be sold.
 *
 * ─── WHAT IT WATCHES ──────────────────────────────────────────────────────────
 * Every ACTIVE loan, valued at its position's CURRENT market value against its
 * own FROZEN liquidation threshold. Two decisions follow, and only two:
 *
 *   - Under the threshold  → nothing. The position keeps earning yield, which
 *     is the entire point of the product.
 *   - At or over          → enqueue a protective sale. Nothing else.
 *
 * The monitor NEVER moves money. It values, decides, and enqueues; the sale
 * itself executes through the outbox in src/lending/liquidation.ts. That split
 * matters: a monitor that sold directly would be a second, unaudited path for
 * taking a user's collateral, and the one operation in this product that
 * happens without their consent is exactly the one that must not be special.
 *
 * ─── TWO TRIGGERS ─────────────────────────────────────────────────────────────
 * The scheduled sweep, and an out-of-cycle check. The second exists because a
 * collateral price that has collapsed will not wait for the next tick: a 15%
 * gap between sweeps is a 15% window in which the recovery value of a bad
 * loan keeps falling. `requestOutOfCycleCheck` is called by the agent when its
 * circuit breaker detects abnormal loss, and forces the monitor to run now
 * regardless of when it last ran.
 *
 * ─── WHY ONE SALE PER LOAN PER TICK ───────────────────────────────────────────
 * Each loan is enqueued under an idempotency key that includes a sequence
 * number derived from the loan's own state, and the executor re-verifies
 * health at execution time and no-ops if the position has already healed. A
 * sale that fires twice is therefore harmless: the second run finds a closed
 * loan and does nothing. The guard here is a cheaper first line that keeps the
 * queue readable.
 */

import { config } from '../config/env'
import db from '../db'
import { logger } from '../utils/logger'
import { enqueueOutboxOp } from '../outbox/service'
import { scheduleResilientJob } from './resilientScheduler'
import { dispatchInBackground } from '../outbox/dispatcher'
import { accrueInterest } from '../lending/accrual'
import { currentLtv, isLiquidationTriggered } from '../lending/risk'

export const LOAN_LIQUIDATION_JOB_NAME = 'loan-liquidation-monitor'

/**
 * Set when an out-of-cycle check is requested while a sweep is in flight, so
 * the request is not silently lost by the sweep already running. Cleared by
 * the sweep that consumes it.
 */
let outOfCycleRequested = false
let outOfCycleRequestedAt: Date | null = null

/**
 * Ask for a liquidation check outside the normal cadence. Called by the agent
 * when its circuit breaker trips on abnormal loss — the signal that collateral
 * prices may have moved sharply in a way the hourly sweep has not yet seen.
 */
export function requestOutOfCycleCheck(reason: string): void {
  outOfCycleRequested = true
  outOfCycleRequestedAt = new Date()
  logger.warn('[Lending] Out-of-cycle liquidation check requested', { reason })
}

export interface LiquidationSweepResult {
  scanned: number
  triggered: number
  enqueued: number
  failed: number
  outOfCycle: boolean
}

export async function runLiquidationSweep(
  options: { trigger?: 'scheduled' | 'circuit_breaker'; limit?: number } = {}
): Promise<LiquidationSweepResult> {
  const trigger = options.trigger ?? 'scheduled'
  const limit = options.limit ?? 200
  const now = new Date()

  // Consume the out-of-cycle request at ENTRY, by whichever sweep gets here
  // first. Clearing it at the end instead would leave it set whenever a
  // circuit-breaker sweep consumed it — and since that sweep is the one the
  // request exists to trigger, the flag would survive it and pin the monitor
  // to out-of-cycle sweeps for the life of the process. Reading it here also
  // closes the mirror-image hole: a request that arrives while this sweep is
  // mid-flight sets the flag again, and the next sweep picks it up.
  const outOfCycleRequestedAtSeen = outOfCycleRequestedAt
  const hadOutOfCycleRequest = outOfCycleRequested
  outOfCycleRequested = false
  outOfCycleRequestedAt = null

  const loans = (await db.collateralLoan.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      userId: true,
      positionId: true,
      borrowedAsset: true,
      principalAmount: true,
      interestAccrued: true,
      interestAccruedTo: true,
      interestRateApy: true,
      liquidationLtvThreshold: true,
      position: {
        select: {
          assetSymbol: true,
          currentValue: true,
          user: { select: { network: true } },
        },
      },
    },
    orderBy: { lastValuedAt: 'asc' },
    take: limit,
  })) as Array<{
    id: string
    userId: string
    positionId: string
    borrowedAsset: string
    principalAmount: unknown
    interestAccrued: unknown
    interestAccruedTo: Date
    interestRateApy: unknown
    liquidationLtvThreshold: unknown
    position: {
      assetSymbol: string
      currentValue: unknown
      user: { network: string }
    }
  }>

  let triggered = 0
  let enqueued = 0
  let failed = 0

  for (const loan of loans) {
    try {
      // Level interest with the clock first: a loan that is only marginally
      // over its threshold is exactly the loan where stale interest decides
      // the outcome, and "we only valued the principal" is not a defence.
      const accrued = await accrueInterest(loan.id, now)

      const debt = accrued.principalAmount + accrued.interestAccrued
      const collateralValue = Number(loan.position.currentValue)
      const threshold = Number(loan.liquidationLtvThreshold)
      const ltv = currentLtv({ debt, collateralValue })

      await db.collateralLoan.update({
        where: { id: loan.id },
        data: { lastValuedAt: now, lastValuedCollateral: collateralValue },
      })

      if (!isLiquidationTriggered(ltv, threshold)) continue
      triggered++

      // The sale needs a ledger Transaction to mirror itself onto, so the row
      // and the outbox op are written together — the same atomicity the money
      // path uses. A loan already carrying an unfinished sale is skipped
      // entirely, which is what keeps a loan from accumulating a queue of
      // sales while the first one is still in flight.
      const queued = await db.$transaction(async (tx) => {
        const inflight = await tx.outboxOp.findFirst({
          where: {
            kind: 'LOAN_LIQUIDATION',
            status: { in: ['PENDING', 'SUBMITTED'] },
            payload: { path: ['loanId'], equals: loan.id },
          },
          select: { id: true },
        })
        if (inflight) return null

        const sequence = accrued.interestAccruedTo.getTime()
        const transaction = await tx.transaction.create({
          data: {
            userId: loan.userId,
            positionId: loan.positionId,
            loanId: loan.id,
            type: 'LOAN_LIQUIDATION',
            status: 'PENDING',
            assetSymbol: loan.position.assetSymbol,
            amount: collateralValue,
            network: loan.position.user.network as never,
            memo: `Collateral liquidation queued (loan:${loan.id}, trigger:${trigger})`,
          },
        })

        const op = await enqueueOutboxOp(tx, {
          // The accrual watermark is monotonic per loan, so this key is stable
          // across a retried sweep of the same breach and fresh once the loan
          // has been re-valued and re-breached after a partial sale.
          idempotencyKey: `LOAN_LIQUIDATION:${loan.id}:${sequence}`,
          userId: loan.userId,
          kind: 'LOAN_LIQUIDATION',
          actor: 'SYSTEM',
          payload: {
            method: 'loan_liquidation',
            userId: loan.userId,
            loanId: loan.id,
            positionId: loan.positionId,
            collateralAmount: collateralValue,
            collateralAssetSymbol: loan.position.assetSymbol,
            debtOutstanding: debt,
            borrowedAsset: loan.borrowedAsset,
            trigger,
            transactionId: transaction.id,
            sequence,
          },
        })

        return op
      })

      if (!queued) continue
      enqueued++
      dispatchInBackground(queued.id)
    } catch (err) {
      failed++
      logger.error('[Lending] Liquidation check failed for loan', {
        loanId: loan.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const result: LiquidationSweepResult = {
    scanned: loans.length,
    triggered,
    enqueued,
    failed,
    outOfCycle: trigger === 'circuit_breaker' || hadOutOfCycleRequest,
  }

  logger.warn('[Lending] Liquidation sweep complete', {
    ...result,
    requestedAt: outOfCycleRequestedAtSeen?.toISOString(),
  })

  return result
}

/**
 * Consume a pending out-of-cycle request, if there is one. Returns null when
 * nothing was requested, so the scheduled tick can stay a cheap no-op.
 */
export async function runOutOfCycleCheckIfRequested(
  reason: string
): Promise<LiquidationSweepResult | null> {
  if (!outOfCycleRequested) return null
  logger.warn('[Lending] Running out-of-cycle liquidation check', { reason })
  return runLiquidationSweep({ trigger: 'circuit_breaker' })
}

export function scheduleLoanLiquidationMonitor(): NodeJS.Timeout {
  return scheduleResilientJob({
    jobName: LOAN_LIQUIDATION_JOB_NAME,
    task: async () => {
      await runOutOfCycleCheckIfRequested('circuit breaker')
      await runLiquidationSweep()
    },
    intervalMs: config.lending.liquidationCheckIntervalMs,
  })
}
