/**
 * Approval expiry sweep (#314).
 *
 * PENDING ApprovalRequests whose expiresAt has passed are transitioned to
 * EXPIRED and a webhook fired, so an operation that never got enough
 * co-signers is surfaced rather than left silently dangling. Unlike
 * decide()'s single-row conditional update (racing against a concurrent
 * approve/reject), this sweep has no other actor contending for the same
 * row transition, so a single batched updateMany is safe — it just can't
 * race against itself.
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
import { dispatchWebhookEvent } from '../services/webhookDispatcher'

export async function sweepExpiredApprovals(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'approval_expiry_sweep'

    try {
      const expired = await db.approvalRequest.findMany({
        where: { status: 'PENDING', expiresAt: { lt: new Date() } },
        select: { id: true, userId: true, actingAsUserId: true },
      })

      if (expired.length > 0) {
        await db.approvalRequest.updateMany({
          where: {
            id: { in: expired.map((r) => r.id) },
            status: 'PENDING',
          },
          data: { status: 'EXPIRED' },
        })

        for (const request of expired) {
          dispatchWebhookEvent('approval.expired', {
            requestId: request.id,
            userId: request.userId,
            actingAsUserId: request.actingAsUserId,
          }).catch(() => {})
        }
      }

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        expiredCount: expired.length,
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
 * Schedule the approval expiry sweep to run once at startup, then on a
 * fixed interval (default: 60s — approval timeouts are typically much
 * shorter-lived than the other cleanup/retention jobs, so this polls more
 * frequently).
 *
 * @returns A NodeJS.Timeout handle (call clearInterval to stop it).
 */
export function scheduleApprovalExpiry(): NodeJS.Timeout {
  sweepExpiredApprovals()

  const handle = setInterval(
    sweepExpiredApprovals,
    config.approvals.expirySweepIntervalMs
  )

  logger.info(
    `[ApprovalExpiry] Scheduler started (interval: ${config.approvals.expirySweepIntervalMs}ms)`
  )
  return handle
}
