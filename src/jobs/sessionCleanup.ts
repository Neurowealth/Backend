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

/**
 * Purge sessions that can no longer be used by anyone.
 * Safe to call multiple times — it is idempotent.
 *
 * #472: "expired" used to mean `expiresAt < now`, which is the *access* token
 * expiry. Refresh tokens live for 7 days while an access token lives for 15
 * minutes, so this job was deleting sessions whose refresh token was still
 * valid — quietly logging users out mid-session and making the whole refresh
 * flow pointless. A session is only purged when both halves are dead:
 *
 *   - live session:   access token expired AND (no refresh token OR refresh expired)
 *   - revoked session: already soft-revoked, kept for the retention window
 *
 * Soft-revocation state is preserved for `config.sessions.revokedRetainDays` so
 * a user can still see, and investigators can still read, what was terminated.
 */
export async function cleanupExpiredSessions(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'session_cleanup'

    try {
      const now = new Date()
      const revokedCutoff = new Date(
        now.getTime() - config.sessions.revokedRetainDays * 24 * 60 * 60 * 1000
      )

      const [expiredResult, revokedResult] = await Promise.all([
        db.session.deleteMany({
          where: {
            expiresAt: { lt: now },
            revokedAt: null,
            OR: [
              // Revoke-aware: #472 cleared the refresh columns on revocation, so a
              // revoked session can never match this branch. Stated explicitly so
              // a future change to revokeSession() cannot silently break it.
              { refreshTokenExpiresAt: null },
              { refreshTokenExpiresAt: { lt: now } },
            ],
          },
        }),
        db.session.deleteMany({
          where: {
            revokedAt: { not: null, lt: revokedCutoff },
          },
        }),
      ])

      const totalDeleted = expiredResult.count + revokedResult.count
      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        rowsDeleted: totalDeleted,
        expiredDeleted: expiredResult.count,
        revokedDeleted: revokedResult.count,
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
 * Schedule the session cleanup job to run once every 24 hours.
 * Also runs immediately on startup to handle any sessions that expired
 * while the server was offline.
 *
 * @returns A NodeJS.Timeout handle (call clearInterval to stop it).
 */
export function scheduleSessionCleanup(): NodeJS.Timeout {
  const handle = scheduleResilientJob({
    jobName: 'session_cleanup',
    task: cleanupExpiredSessions,
    intervalMs: config.jwt.interval_ms,
  })

  logger.info('[SessionCleanup] Daily cleanup scheduled')
  return handle
}
