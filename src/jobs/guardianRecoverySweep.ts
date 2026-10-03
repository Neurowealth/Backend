/**
 * Guardian recovery sweep (#535).
 *
 * This job is the ONLY caller of `executeRecovery`. That is deliberate and is
 * the reason the service exposes no execution endpoint:
 *
 * - A route would be reachable only by an authenticated user of the account
 *   being recovered, and the instant it succeeded every one of their sessions
 *   would be revoked — so the caller would lock themselves out mid-request and
 *   nobody could ever invoke it.
 * - Recovery is platform-side work. It is driven by time, not by a caller, and
 *   the deadline it enforces (`executeAfter`) was stamped onto the request row
 *   when quorum was reached and cannot be moved afterwards.
 *
 * Two passes per tick:
 *
 *   1. Expire requests that aged out before ever reaching quorum. Pure
 *      housekeeping — it closes rows that can no longer change anything.
 *   2. Execute requests whose mandatory delay has elapsed. `executeRecovery`
 *      re-verifies the deadline and wins the cancel-vs-execute race with a
 *      conditional update, so running two of these concurrently is safe.
 */
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
import {
  OPEN_REQUEST_STATUSES,
  executeRecovery,
  expireStaleRequests,
} from '../guardians/service'

/**
 * Find requests whose delay has elapsed. The `executeAfter <= now` filter is
 * the coarse gate; `executeRecovery` re-checks it per row so that a bug in this
 * query cannot shorten the mandatory window.
 */
async function findDueRequests(
  now: Date
): Promise<Array<{ id: string; userId: string }>> {
  return db.recoveryRequest.findMany({
    where: {
      status: 'QUORUM_REACHED',
      executeAfter: { lte: now },
      expiresAt: { gt: now },
    },
    select: { id: true, userId: true },
    orderBy: { executeAfter: 'asc' },
    take: config.recovery.sweepBatchSize,
  })
}

export async function sweepGuardianRecovery(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'guardian_recovery_sweep'
    // One `now` for the whole tick. Deriving a fresh Date() per row would let a
    // long-running sweep execute a request whose deadline had not actually
    // passed at the start of the pass.
    const now = new Date()

    try {
      const expired = await expireStaleRequests(now)

      const due = await findDueRequests(now)

      let executed = 0
      let skipped = 0

      for (const request of due) {
        try {
          const outcome = await executeRecovery(request.id, now)
          if (outcome.executed) {
            executed++
          } else {
            // Lost the race to a cancellation, an expiry, or another pod. Not an
            // error: the conditional update in executeRecovery decided it.
            skipped++
          }
        } catch (err) {
          // One bad request must not strand the rest of the batch. Leave it for
          // the next tick; if it is genuinely stuck, the error surfaces on every
          // pass rather than being swallowed.
          skipped++
          logger.error('[Guardians] Recovery execution failed for a request', {
            requestId: request.id,
            userId: request.userId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (executed > 0) {
        logger.warn('[Guardians] Recovery sweep executed due requests', {
          executed,
          skipped,
          expired,
        })
      }

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        dueCount: due.length,
        executed,
        skipped,
        expired,
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
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

/**
 * Schedule the recovery sweep. Runs once at startup and then on a fixed
 * interval; `scheduleResilientJob` prevents overlapping runs on this pod and
 * retries transient failures with backoff.
 *
 * @returns A NodeJS.Timeout handle (pass to clearInterval on shutdown).
 */
export function scheduleGuardianRecoverySweep(): NodeJS.Timeout {
  const handle = scheduleResilientJob({
    jobName: 'guardian_recovery_sweep',
    task: sweepGuardianRecovery,
    intervalMs: config.recovery.sweepIntervalMs,
  })

  logger.info(
    `[Guardians] Recovery sweep scheduled (interval: ${config.recovery.sweepIntervalMs}ms, open statuses: ${OPEN_REQUEST_STATUSES.length})`
  )
  return handle
}
