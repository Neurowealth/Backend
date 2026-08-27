import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob, recordRetentionDeletes } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import {
  appendAuditBlock,
  aggregatePayloadHash,
  GENESIS_AUDIT_HASH,
} from '../audit/chain'
import { trimUserEventStreams } from '../events/store'

function cutoffDate(retentionDays: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - retentionDays)
  return d
}

async function anchorBeforeDelete(
  modelName: string,
  rows: Array<Record<string, unknown>>
): Promise<string | null> {
  if (rows.length === 0) return null

  const payloadHash = aggregatePayloadHash(rows)
  const latest = await db.auditBlock.findFirst({
    orderBy: { height: 'desc' },
    select: { hash: true, height: true },
  })

  const block = appendAuditBlock({
    height: (latest?.height ?? 0) + 1,
    prevHash: latest?.hash ?? GENESIS_AUDIT_HASH,
    payloadHash,
    blockType: 'ANCHOR',
    createdAt: new Date(),
    payloads: rows.map((row) => ({ modelName, row })),
  })

  await db.auditBlock.create({
    data: {
      height: block.height,
      prevHash: block.prevHash,
      hash: block.hash,
      blockType: block.blockType,
      payloadCount: block.payloadCount,
      payloadHash: block.payloadHash,
      createdAt: block.createdAt,
    },
  })

  return block.hash
}

/**
 * Delete expired auth_nonces (expiresAt < now).
 */
export async function cleanupAuthNonces(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_auth_nonces'

    try {
      const result = await db.authNonce.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      })
      const durationMs = Date.now() - start
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
      })

      if (result.count > 0) {
        recordRetentionDeletes('auth_nonces', result.count)
      }
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
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
 * Prune processed_events older than RETENTION_PROCESSED_EVENTS_DAYS (default 90).
 */
export async function cleanupProcessedEvents(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_processed_events'

    try {
      const cutoff = cutoffDate(config.retention.processedEventsDays)
      const rows = await db.processedEvent.findMany({
        where: { processedAt: { lt: cutoff } },
        select: {
          id: true,
          contractId: true,
          txHash: true,
          eventType: true,
          ledger: true,
          processedAt: true,
        },
      })
      if (rows.length > 0) {
        await anchorBeforeDelete('processed_event', rows)
      }
      const result = await db.processedEvent.deleteMany({
        where: { processedAt: { lt: cutoff } },
      })
      const durationMs = Date.now() - start
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
        retentionDays: config.retention.processedEventsDays,
      })

      if (result.count > 0) {
        recordRetentionDeletes('processed_events', result.count)
      }
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const duration = durationMs / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        retentionDays: config.retention.processedEventsDays,
      })

      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Prune RESOLVED dead_letter_events older than RETENTION_DEAD_LETTER_EVENTS_DAYS (default 30).
 * PENDING and RETRIED records are left untouched so they remain actionable.
 */
export async function cleanupDeadLetterEvents(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_dead_letter_events'

    try {
      const cutoff = cutoffDate(config.retention.deadLetterEventsDays)
      const result = await db.deadLetterEvent.deleteMany({
        where: {
          status: 'RESOLVED',
          createdAt: { lt: cutoff },
        },
      })
      const durationMs = Date.now() - start
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
        eventStatus: 'RESOLVED',
        retentionDays: config.retention.deadLetterEventsDays,
      })

      if (result.count > 0) {
        recordRetentionDeletes('dead_letter_events', result.count)
      }
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const duration = durationMs / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        eventStatus: 'RESOLVED',
        retentionDays: config.retention.deadLetterEventsDays,
      })

      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Prune agent_logs older than RETENTION_AGENT_LOGS_DAYS (default 60).
 */
export async function cleanupAgentLogs(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_agent_logs'

    try {
      const cutoff = cutoffDate(config.retention.agentLogsDays)
      const rows = await db.agentLog.findMany({
        where: { createdAt: { lt: cutoff } },
        select: {
          id: true,
          action: true,
          status: true,
          createdAt: true,
          userId: true,
          positionId: true,
        },
      })
      if (rows.length > 0) {
        await anchorBeforeDelete('agent_log', rows)
      }
      const result = await db.agentLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      })
      const durationMs = Date.now() - start
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
        retentionDays: config.retention.agentLogsDays,
      })

      if (result.count > 0) {
        recordRetentionDeletes('agent_logs', result.count)
      }
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const duration = durationMs / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        retentionDays: config.retention.agentLogsDays,
      })

      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Prune the real-time user event stream (#316).
 *
 * Two bounds, both required. Age (RETENTION_USER_EVENTS_DAYS, default 7) is the
 * one clients reason about: a client offline longer than this gets a `gap`
 * frame and re-fetches a REST snapshot. The per-user row cap
 * (USER_EVENT_STREAM_MAX_PER_USER) is the one that protects the pod: age alone
 * lets a single pathological account grow without limit inside the window, and
 * the whole promise of this table is that no user can do that.
 *
 * Deliberately NOT anchored into the audit chain like processed_events: these
 * rows are a redacted, short-lived projection of events whose authoritative
 * records (Transaction, ProcessedEvent, AgentLog) are anchored already. Hashing
 * them again would anchor a copy, not evidence.
 */
export async function cleanupUserEvents(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_user_events'

    try {
      const cutoff = cutoffDate(config.retention.userEventsDays)
      const expired = await db.userEvent.deleteMany({
        where: { createdAt: { lt: cutoff } },
      })
      const trimmed = await trimUserEventStreams(
        config.retention.userEventsMaxPerUser
      )

      const durationMs = Date.now() - start
      const duration = durationMs / 1000
      const rowsDeleted = expired.count + trimmed

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted,
        expiredByAge: expired.count,
        trimmedByCap: trimmed,
        retentionDays: config.retention.userEventsDays,
        maxPerUser: config.retention.userEventsMaxPerUser,
      })

      if (rowsDeleted > 0) {
        recordRetentionDeletes('user_events', rowsDeleted)
      }
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const duration = durationMs / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        retentionDays: config.retention.userEventsDays,
      })

      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Run all retention jobs sequentially.
 */
export async function runAllRetentionJobs(): Promise<void> {
  const correlationId = generateCorrelationId()
  await runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'retention_all_jobs'

    logger.info(`[${jobName}] Starting all retention cleanup jobs`, {
      correlationId,
    })

    try {
      await cleanupAuthNonces()
      await cleanupProcessedEvents()
      await cleanupDeadLetterEvents()
      await cleanupAgentLogs()
      await cleanupUserEvents()

      const duration = (Date.now() - startTime) / 1000
      logBackgroundJob(jobName, 'success', duration, correlationId)
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
      })
    }
  })
}

/**
 * Schedule the retention cleanup jobs.
 * Runs once on startup then on the configured interval (default 24 h).
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleDataRetention(): NodeJS.Timeout {
  runAllRetentionJobs()
  const handle = setInterval(runAllRetentionJobs, config.retention.intervalMs)
  logger.info(
    `[DataRetention] Retention jobs scheduled every ${config.retention.intervalMs / 3600000}h` +
      ` (processed_events=${config.retention.processedEventsDays}d,` +
      ` dlq=${config.retention.deadLetterEventsDays}d,` +
      ` agent_logs=${config.retention.agentLogsDays}d,` +
      ` user_events=${config.retention.userEventsDays}d/` +
      `${config.retention.userEventsMaxPerUser} per user)`
  )
  return handle
}
