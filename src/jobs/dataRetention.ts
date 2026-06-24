import db from '../db';
import { logger, logBackgroundJob } from '../utils/logger';
import { generateCorrelationId, runWithCorrelationIdAsync, getCorrelationId } from '../utils/correlation';
import { config } from '../config/env';
import { recordBackgroundJob, recordRetentionDeletes } from '../utils/metrics';

function cutoffDate(retentionDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - retentionDays);
  return d;
}

/**
 * Delete expired auth_nonces (expiresAt < now).
 */
export async function cleanupAuthNonces(): Promise<void> {
  const correlationId = generateCorrelationId();
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now();
    const jobName = 'retention_auth_nonces';

    try {
      const result = await db.authNonce.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      const duration = (Date.now() - start) / 1000;

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
      });

      if (result.count > 0) {
        recordRetentionDeletes('auth_nonces', result.count);
      }
      recordBackgroundJob(jobName, 'success', duration);
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
      });

      recordBackgroundJob(jobName, 'failed', duration);
    }
  });
}

/**
 * Prune processed_events older than RETENTION_PROCESSED_EVENTS_DAYS (default 90).
 */
export async function cleanupProcessedEvents(): Promise<void> {
  const correlationId = generateCorrelationId();
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now();
    const jobName = 'retention_processed_events';

    try {
      const cutoff = cutoffDate(config.retention.processedEventsDays);
      const result = await db.processedEvent.deleteMany({
        where: { processedAt: { lt: cutoff } },
      });
      const duration = (Date.now() - start) / 1000;

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
        retentionDays: config.retention.processedEventsDays,
      });

      if (result.count > 0) {
        recordRetentionDeletes('processed_events', result.count);
      }
      recordBackgroundJob(jobName, 'success', duration);
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        retentionDays: config.retention.processedEventsDays,
      });

      recordBackgroundJob(jobName, 'failed', duration);
    }
  });
}

/**
 * Prune RESOLVED dead_letter_events older than RETENTION_DEAD_LETTER_EVENTS_DAYS (default 30).
 * PENDING and RETRIED records are left untouched so they remain actionable.
 */
export async function cleanupDeadLetterEvents(): Promise<void> {
  const correlationId = generateCorrelationId();
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now();
    const jobName = 'retention_dead_letter_events';

    try {
      const cutoff = cutoffDate(config.retention.deadLetterEventsDays);
      const result = await db.deadLetterEvent.deleteMany({
        where: {
          status: 'RESOLVED',
          createdAt: { lt: cutoff },
        },
      });
      const duration = (Date.now() - start) / 1000;

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
        eventStatus: 'RESOLVED',
        retentionDays: config.retention.deadLetterEventsDays,
      });

      if (result.count > 0) {
        recordRetentionDeletes('dead_letter_events', result.count);
      }
      recordBackgroundJob(jobName, 'success', duration);
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        eventStatus: 'RESOLVED',
        retentionDays: config.retention.deadLetterEventsDays,
      });

      recordBackgroundJob(jobName, 'failed', duration);
    }
  });
}

/**
 * Prune agent_logs older than RETENTION_AGENT_LOGS_DAYS (default 60).
 */
export async function cleanupAgentLogs(): Promise<void> {
  const correlationId = generateCorrelationId();
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now();
    const jobName = 'retention_agent_logs';

    try {
      const cutoff = cutoffDate(config.retention.agentLogsDays);
      const result = await db.agentLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      const duration = (Date.now() - start) / 1000;

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
        retentionDays: config.retention.agentLogsDays,
      });

      if (result.count > 0) {
        recordRetentionDeletes('agent_logs', result.count);
      }
      recordBackgroundJob(jobName, 'success', duration);
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
        retentionDays: config.retention.agentLogsDays,
      });

      recordBackgroundJob(jobName, 'failed', duration);
    }
  });
}

/**
 * Run all retention jobs sequentially.
 */
export async function runAllRetentionJobs(): Promise<void> {
  const correlationId = generateCorrelationId();
  await runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now();
    const jobName = 'retention_all_jobs';

    logger.info(`[${jobName}] Starting all retention cleanup jobs`, { correlationId });

    try {
      await cleanupAuthNonces();
      await cleanupProcessedEvents();
      await cleanupDeadLetterEvents();
      await cleanupAgentLogs();

      const duration = (Date.now() - startTime) / 1000;
      logBackgroundJob(jobName, 'success', duration, correlationId);
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
      });
    }
  });
}

/**
 * Schedule the retention cleanup jobs.
 * Runs once on startup then on the configured interval (default 24 h).
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleDataRetention(): NodeJS.Timeout {
  runAllRetentionJobs();
  const handle = setInterval(runAllRetentionJobs, config.retention.intervalMs);
  logger.info(
    `[DataRetention] Retention jobs scheduled every ${config.retention.intervalMs / 3600000}h` +
    ` (processed_events=${config.retention.processedEventsDays}d,` +
    ` dlq=${config.retention.deadLetterEventsDays}d,` +
    ` agent_logs=${config.retention.agentLogsDays}d)`,
  );
  return handle;
}
