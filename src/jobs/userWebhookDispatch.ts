import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import { processUserWebhookDeliveries } from '../services/userWebhookDispatcher'

const JOB_NAME = 'user_webhook_dispatch'
const INTERVAL_MS = 10000 // 10 seconds

/**
 * Sweeps and delivers pending user webhook events.
 */
export async function runUserWebhookDispatch(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()

    try {
      const result = await processUserWebhookDeliveries(50)
      const durationMs = Date.now() - start

      if (result.processed > 0) {
        logBackgroundJob(JOB_NAME, 'success', durationMs / 1000, correlationId, {
          processed: result.processed,
          delivered: result.delivered,
          retried: result.retried,
          failed: result.failed,
        })
      }
      recordJobSuccess(JOB_NAME, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      logBackgroundJob(JOB_NAME, 'failed', durationMs / 1000, correlationId, {
        error: errorMessage,
      })
      recordJobFailure(JOB_NAME, durationMs, error)
      logger.error(`[${JOB_NAME}] Sweep execution failed`, {
        error: errorMessage,
        correlationId,
      })
    }
  })
}

/**
 * Schedule recurring user webhook dispatch sweep.
 */
export function scheduleUserWebhookDispatch(): NodeJS.Timeout {
  const handle = scheduleResilientJob({
    jobName: JOB_NAME,
    task: runUserWebhookDispatch,
    intervalMs: INTERVAL_MS,
    unref: true,
  })

  logger.info(`[UserWebhooks] Dispatch sweep scheduled every ${INTERVAL_MS}ms`)
  return handle
}
