import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { suggestAllocation } from '../analytics/service'

/**
 * Allocation-suggestion precompute job (#322).
 *
 * Refreshes each invested user's stored AllocationSuggestion so the history
 * endpoint has something current to show without a user paying for a solve
 * on their first request. All the math lives in src/analytics/ (pure + unit
 * tested); this job is DB glue and scheduling only, mirroring
 * src/jobs/strategyMetrics.ts and src/jobs/protocolRiskScoring.ts.
 *
 * ─── STILL ADVISORY ──────────────────────────────────────────────────────────
 *
 * This job writes AllocationSuggestion rows and NOTHING else. It does not touch
 * User.strategyConfig, so it cannot change what the agent does on its next tick.
 * A precompute job that quietly rewrote strategy configs on a 6-hour timer would
 * be an autonomous trading system wearing an analytics job's clothes.
 *
 * ─── SCOPE AND COST ──────────────────────────────────────────────────────────
 *
 * Only users with an ACTIVE Position: someone with no funds deployed has nothing
 * to reallocate, and including them would multiply the cost of the most
 * expensive job in the process by the size of the whole user table.
 *
 * The backtest legs are SKIPPED here (`runBacktest: false`). They are two full
 * historical replays per user and are only interesting when a human is looking
 * at the result, which is exactly when the POST endpoint runs them live. Rows
 * written by this job therefore carry a null backtest — documented in
 * docs/PORTFOLIO_OPTIMIZATION.md so an absent comparison never reads as a
 * failure.
 *
 * Batches with a serial await inside each batch, same loop shape as the
 * neighbouring jobs: the optimizer is CPU-bound on the single event-loop thread,
 * so parallelizing users here would starve live requests rather than finish
 * sooner.
 */

export async function computeAllocationSuggestions(
  now: Date = new Date()
): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'allocation_suggestions'

    try {
      const invested = await db.position.findMany({
        where: { status: 'ACTIVE' },
        select: { userId: true },
        distinct: ['userId'],
      })

      const userIds = invested.map((p) => p.userId)
      const batchSize = Math.max(1, config.allocationSuggestions.batchSize)

      let computed = 0
      let failed = 0

      for (let i = 0; i < userIds.length; i += batchSize) {
        const batch = userIds.slice(i, i + batchSize)

        for (const userId of batch) {
          try {
            await suggestAllocation(userId, {
              now,
              persist: true,
              runBacktest: false,
            })
            computed++
          } catch (error) {
            // One user's failure must never abort the batch — a single corrupt
            // strategyConfig or a deleted user mid-run would otherwise silently
            // deprive everyone after them of a refreshed suggestion.
            failed++
            logger.error('[AllocationSuggestions] Failed to compute for user', {
              userId,
              error: error instanceof Error ? error.message : 'Unknown error',
            })
          }
        }
      }

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        usersConsidered: userIds.length,
        computed,
        failed,
      })
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
      })
      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Schedule the allocation-suggestion job. Runs once on startup then on the
 * configured interval (default 6 h, matching protocolRisk and strategyMetrics).
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleAllocationSuggestions(): NodeJS.Timeout {
  void computeAllocationSuggestions()

  const intervalMs = config.allocationSuggestions.intervalMs
  const handle = setInterval(() => {
    void computeAllocationSuggestions()
  }, intervalMs)

  handle.unref?.()

  logger.info(
    `[AllocationSuggestions] Allocation suggestions scheduled every ${intervalMs / 3600000}h`
  )
  return handle
}
