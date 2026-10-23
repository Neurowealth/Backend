import db from '../db'
import type { Prisma } from '@prisma/client'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob, recordRetentionDeletes } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import {
  appendAuditBlock,
  aggregatePayloadHash,
  GENESIS_AUDIT_HASH,
} from '../audit/chain'
import { trimUserEventStreams } from '../events/store'

function cutoffDate(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 86400000)
}

export async function anchorBeforeDelete(
  modelName: string,
  rows: Array<Record<string, unknown>>,
  client: Pick<Prisma.TransactionClient, 'auditBlock'> | typeof db = db
): Promise<string | null> {
  if (rows.length === 0) return null

  const payloadHash = aggregatePayloadHash(rows)
  const latest = await client.auditBlock.findFirst({
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

  await client.auditBlock.create({
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
  const dryRun = process.env.DATA_RETENTION_DRY_RUN === 'true'
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_auth_nonces'

    try {
      const count = await db.authNonce.count({
        where: { expiresAt: { lt: new Date() } },
      })

      if (dryRun) {
        const durationMs = Date.now() - start
        const duration = durationMs / 1000
        logBackgroundJob(jobName, 'dry_run', duration, correlationId, {
          wouldDelete: count,
        })
        recordBackgroundJob(jobName, 'dry_run', duration)
        return
      }

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
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

/**
 * Prune processed_events older than RETENTION_PROCESSED_EVENTS_DAYS (default 90).
 */
export async function cleanupProcessedEvents(): Promise<void> {
  const correlationId = generateCorrelationId()
  const dryRun = process.env.DATA_RETENTION_DRY_RUN === 'true'
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

      if (dryRun) {
        const durationMs = Date.now() - start
        const duration = durationMs / 1000
        logBackgroundJob(jobName, 'dry_run', duration, correlationId, {
          wouldDelete: rows.length,
          retentionDays: config.retention.processedEventsDays,
        })
        recordBackgroundJob(jobName, 'dry_run', duration)
        return
      }

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
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

/**
 * Prune RESOLVED dead_letter_events older than RETENTION_DEAD_LETTER_EVENTS_DAYS (default 30).
 * PENDING and RETRIED records are left untouched so they remain actionable.
 */
export async function cleanupDeadLetterEvents(): Promise<void> {
  const correlationId = generateCorrelationId()
  const dryRun = process.env.DATA_RETENTION_DRY_RUN === 'true'
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_dead_letter_events'

    try {
      const cutoff = cutoffDate(config.retention.deadLetterEventsDays)
      const count = await db.deadLetterEvent.count({
        where: {
          status: 'RESOLVED',
          createdAt: { lt: cutoff },
        },
      })

      if (dryRun) {
        const durationMs = Date.now() - start
        const duration = durationMs / 1000
        logBackgroundJob(jobName, 'dry_run', duration, correlationId, {
          wouldDelete: count,
          eventStatus: 'RESOLVED',
          retentionDays: config.retention.deadLetterEventsDays,
        })
        recordBackgroundJob(jobName, 'dry_run', duration)
        return
      }

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
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

/**
 * Prune agent_logs older than RETENTION_AGENT_LOGS_DAYS (default 60).
 */
export async function cleanupAgentLogs(): Promise<void> {
  const correlationId = generateCorrelationId()
  const dryRun = process.env.DATA_RETENTION_DRY_RUN === 'true'
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

      if (dryRun) {
        const durationMs = Date.now() - start
        const duration = durationMs / 1000
        logBackgroundJob(jobName, 'dry_run', duration, correlationId, {
          wouldDelete: rows.length,
          retentionDays: config.retention.agentLogsDays,
        })
        recordBackgroundJob(jobName, 'dry_run', duration)
        return
      }

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
      recordJobFailure(jobName, durationMs, error)
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
  const dryRun = process.env.DATA_RETENTION_DRY_RUN === 'true'
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_user_events'

    try {
      const cutoff = cutoffDate(config.retention.userEventsDays)
      const expiredCount = await db.userEvent.count({
        where: { createdAt: { lt: cutoff } },
      })

      if (dryRun) {
        const trimmed = await trimUserEventStreams(
          config.retention.userEventsMaxPerUser
        )
        const durationMs = Date.now() - start
        const duration = durationMs / 1000
        const wouldDelete = expiredCount + trimmed

        logBackgroundJob(jobName, 'dry_run', duration, correlationId, {
          wouldDelete,
          wouldExpireByAge: expiredCount,
          wouldTrimByCap: trimmed,
          retentionDays: config.retention.userEventsDays,
          maxPerUser: config.retention.userEventsMaxPerUser,
        })
        recordBackgroundJob(jobName, 'dry_run', duration)
        return
      }

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
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

/**
 * Prune admin_audit_logs older than RETENTION_ADMIN_AUDIT_LOGS_DAYS (default 365) (#682).
 *
 * Guaranteed append-only at the DB layer via PostgreSQL trigger.
 * Deletion is permitted ONLY when:
 *   1. Legal hold is NOT active (ADMIN_AUDIT_LEGAL_HOLD !== 'true' and neuro.legal_hold !== 'true').
 *   2. Session explicitly executes `SET LOCAL neuro.allow_audit_retention_purge = 'true'` inside a transaction.
 *
 * Before removal, expired rows are cryptographically anchored to the audit block chain.
 */
export async function cleanupAdminAuditLogs(): Promise<void> {
  const correlationId = generateCorrelationId()
  const dryRun = process.env.DATA_RETENTION_DRY_RUN === 'true'
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'retention_admin_audit_logs'

    try {
      // Step 1: Check legal hold override
      if (config.retention.adminAuditLegalHold) {
        const durationMs = Date.now() - start
        const duration = durationMs / 1000
        logBackgroundJob(jobName, 'skipped', duration, correlationId, {
          reason: 'legal_hold_active',
          retentionDays: config.retention.adminAuditLogsDays,
        })
        logger.warn(
          `[${jobName}] Legal hold is active (ADMIN_AUDIT_LEGAL_HOLD=true); skipping admin audit log retention prune`
        )
        recordBackgroundJob(jobName, 'skipped', duration)
        recordJobSuccess(jobName, durationMs)
        return
      }

      const cutoff = cutoffDate(config.retention.adminAuditLogsDays)

      if (dryRun) {
        const wouldDelete = await db.adminAuditLog.count({
          where: { createdAt: { lt: cutoff } },
        })
        const durationMs = Date.now() - start
        const duration = durationMs / 1000
        logBackgroundJob(jobName, 'dry_run', duration, correlationId, {
          wouldDelete,
          retentionDays: config.retention.adminAuditLogsDays,
        })
        recordBackgroundJob(jobName, 'dry_run', duration)
        return
      }

      let deletedCount = 0
      while (true) {
        const batchDeleted = await db.$transaction(async (tx) => {
          // Lock one bounded batch so competing workers cannot anchor/delete
          // the same rows. The anchor and purge share this transaction.
          const rows = await tx.$queryRaw<
            Array<Record<string, unknown> & { id: string }>
          >`SELECT id, "adminKeyId", action, result, "createdAt"
            FROM public.admin_audit_logs
            WHERE "createdAt" < ${cutoff}
            ORDER BY "createdAt" ASC, id ASC
            LIMIT 500
            FOR UPDATE SKIP LOCKED`

          if (rows.length === 0) return 0

          await anchorBeforeDelete('admin_audit_log', rows, tx)
          const ids = rows.map((row) => row.id)
          const deleted = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT public.purge_admin_audit_logs(${ids}::text[], ${cutoff}::timestamptz) AS id
          `
          return deleted.length
        })
        deletedCount += batchDeleted
        if (batchDeleted < 500) break
      }

      const durationMs = Date.now() - start
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: deletedCount,
        retentionDays: config.retention.adminAuditLogsDays,
      })

      if (deletedCount > 0) {
        recordRetentionDeletes('admin_audit_logs', deletedCount)
      }
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const duration = durationMs / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      if (/protected by legal hold/i.test(errorMessage)) {
        logBackgroundJob(jobName, 'skipped', duration, correlationId, {
          reason: 'database_legal_hold_active',
          retentionDays: config.retention.adminAuditLogsDays,
        })
        logger.warn(
          `[${jobName}] Database legal hold is active; skipping purge`
        )
        recordBackgroundJob(jobName, 'skipped', duration)
        recordJobSuccess(jobName, durationMs)
        return
      }

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        retentionDays: config.retention.adminAuditLogsDays,
      })

      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs, error)
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

    const steps: Array<[string, () => Promise<void>]> = [
      ['retention_auth_nonces', cleanupAuthNonces],
      ['retention_processed_events', cleanupProcessedEvents],
      ['retention_dead_letter_events', cleanupDeadLetterEvents],
      ['retention_agent_logs', cleanupAgentLogs],
      ['retention_user_events', cleanupUserEvents],
      ['retention_admin_audit_logs', cleanupAdminAuditLogs],
    ]
    const failures: string[] = []

    for (const [name, step] of steps) {
      try {
        await step()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${name}: ${message}`)
      }
    }

    const durationMs = Date.now() - startTime
    const duration = durationMs / 1000

    if (failures.length > 0) {
      const errorMessage = failures.join('; ')
      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        failedJobs: failures.length,
      })
      recordJobFailure(
        jobName,
        durationMs,
        new Error(
          `Retention sweep incomplete (${failures.length} job(s)): ${errorMessage}`
        )
      )
    }

    logBackgroundJob(jobName, 'success', duration, correlationId)
    recordJobSuccess(jobName, durationMs)
  })
}

/**
 * Schedule the retention cleanup jobs.
 * Runs once on startup then on the configured interval (default 24 h).
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleDataRetention(): NodeJS.Timeout {
  const handle = scheduleResilientJob({
    jobName: 'retention_all_jobs',
    task: runAllRetentionJobs,
    intervalMs: config.retention.intervalMs,
  })
  logger.info(
    `[DataRetention] Retention jobs scheduled every ${config.retention.intervalMs / 3600000}h` +
      ` (processed_events=${config.retention.processedEventsDays}d,` +
      ` dlq=${config.retention.deadLetterEventsDays}d,` +
      ` agent_logs=${config.retention.agentLogsDays}d,` +
      ` user_events=${config.retention.userEventsDays}d/` +
      `${config.retention.userEventsMaxPerUser} per user,` +
      ` admin_audit_logs=${config.retention.adminAuditLogsDays}d)`
  )
  return handle
}
