import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'

/**
 * Delete all sessions whose expiration timestamp is in the past.
 * Safe to call multiple times — it is idempotent.
 */
export async function cleanupExpiredSessions(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'session_cleanup'

    try {
      const result = await db.session.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      })
      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: result.count,
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
 * Schedule the session cleanup job to run once every 24 hours.
 * Also runs immediately on startup to handle any sessions that expired
 * while the server was offline.
 *
 * @returns A NodeJS.Timeout handle (call clearInterval to stop it).
 */
export function scheduleSessionCleanup(): NodeJS.Timeout {
  // Run once at startup
  cleanupExpiredSessions()

  // Then run every 24 hours
  const handle = setInterval(cleanupExpiredSessions, config.jwt.interval_ms)

  logger.info('[SessionCleanup] Daily cleanup scheduled')
  return handle
}
