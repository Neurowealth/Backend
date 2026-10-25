import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import { config } from '../config/env'
import { messageDeliveryService } from '../messaging/service'
import { alertingService } from '../services/alerting'

const JOB_NAME = 'message_delivery_sweep'

/**
 * Sweeps the message queue to retry pending/failed deliveries and monitor DLQ health (#493).
 */
export async function runMessageDeliverySweep(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()

    try {
      const result = await messageDeliveryService.processPendingQueue(50)
      const stats = await messageDeliveryService.getMessageStats()

      const durationMs = Date.now() - start
      logBackgroundJob(JOB_NAME, 'success', durationMs / 1000, correlationId, {
        processed: result.processed,
        delivered: result.delivered,
        retried: result.retried,
        deadLettered: result.deadLettered,
        totalDeadLetter: stats.byStatus.deadLetter,
      })
      recordJobSuccess(JOB_NAME, durationMs)

      // Alerting if dead letters exceed configured threshold
      const dlqThreshold = config.messaging.dlqAlertThreshold || 5
      if (stats.byStatus.deadLetter >= dlqThreshold) {
        await alertingService
          .emit(
            {
              title: 'Message Delivery DLQ Threshold Exceeded',
              description: `Messaging dead-letter queue currently contains ${stats.byStatus.deadLetter} undeliverable messages (threshold: ${dlqThreshold}).`,
              severity: 'warning',
              component: 'messaging_dlq',
              metadata: {
                totalDeadLetter: stats.byStatus.deadLetter,
                threshold: dlqThreshold,
                byChannel: stats.byChannel,
              },
            },
            'messaging_dlq_threshold'
          )
          .catch(() => {})
      }
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
 * Schedule recurring message delivery retry and recovery sweep.
 */
export function scheduleMessageDeliverySweep(): NodeJS.Timeout {
  const handle = scheduleResilientJob({
    jobName: JOB_NAME,
    task: runMessageDeliverySweep,
    intervalMs: config.messaging.retryIntervalMs,
    unref: true,
  })

  logger.info(
    `[Messaging] Message delivery sweep scheduled every ${config.messaging.retryIntervalMs}ms`
  )
  return handle
}
