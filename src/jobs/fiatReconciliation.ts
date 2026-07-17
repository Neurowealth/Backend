import { logger, logBackgroundJob } from '../utils/logger'
import { generateCorrelationId, runWithCorrelationIdAsync } from '../utils/correlation'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { reconcileFiatOrders, ageOutStaleFiatOrders } from '../fiat/service'

/** Interval between reconciliation sweeps (default: 5 minutes). */
const FIAT_RECONCILE_INTERVAL_MS = Number(
  process.env.FIAT_RECONCILE_INTERVAL_MS || 5 * 60 * 1000,
)

/**
 * Reconcile PROCESSING fiat orders against confirmed on-chain transactions and
 * age-out stale PENDING orders. Idempotent — safe to run repeatedly.
 */
export async function runFiatReconciliation(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'fiat_reconciliation'

    try {
      const { scanned, settled } = await reconcileFiatOrders()
      const { failed } = await ageOutStaleFiatOrders()

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        scanned,
        settled,
        agedOut: failed,
      })

      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
      })

      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Schedule the fiat reconciliation job. Runs once at startup to catch anything
 * that settled while offline, then on a fixed interval.
 *
 * @returns A NodeJS.Timeout handle (call clearInterval to stop it).
 */
export function scheduleFiatReconciliation(): NodeJS.Timeout {
  runFiatReconciliation()

  const handle = setInterval(runFiatReconciliation, FIAT_RECONCILE_INTERVAL_MS)

  logger.info('[FiatReconciliation] Reconciliation scheduled', {
    intervalMs: FIAT_RECONCILE_INTERVAL_MS,
  })
  return handle
}
