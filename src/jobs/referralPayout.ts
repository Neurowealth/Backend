import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { config } from '../config'
import { payoutActivatedConversions } from '../referral/service'

/** Interval between referral payout sweeps. */
const REFERRAL_PAYOUT_INTERVAL_MS = config.referral.payoutIntervalMs

/**
 * Pay out ACTIVATED referral conversions that have not yet been fully rewarded.
 *
 * Deliberately separate from the activation step (which runs inside the deposit
 * DB transaction): payouts are irreversible on-chain calls and must not run
 * inside that transaction. Idempotent and retriable — a conversion whose payout
 * fails stays ACTIVATED with payoutError set and is retried on the next sweep,
 * never silently lost.
 */
export async function runReferralPayout(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'referral_payout'

    try {
      const { scanned, rewarded } = await payoutActivatedConversions()

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        scanned,
        rewarded,
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
 * Schedule the referral payout job. Runs once at startup to clear any backlog
 * that accumulated while offline, then on a fixed interval.
 *
 * @returns A NodeJS.Timeout handle (call clearInterval to stop it).
 */
export function scheduleReferralPayout(): NodeJS.Timeout {
  runReferralPayout()

  const handle = setInterval(runReferralPayout, REFERRAL_PAYOUT_INTERVAL_MS)

  logger.info('[ReferralPayout] Payout job scheduled', {
    intervalMs: REFERRAL_PAYOUT_INTERVAL_MS,
  })
  return handle
}
