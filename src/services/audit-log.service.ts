/**
 * Audit log service (#abf9a99).
 *
 * Records security-relevant user actions to `AdminAuditLog` for compliance
 * traceability. Intentionally fire-and-forget: a logging failure must never
 * block the primary user action, so errors are swallowed and reported to the
 * app logger only.
 */

import db from '../db'
import { logger } from '../utils/logger'

export interface AuditEntry {
  userId: string
  action: string
  metadata?: Record<string, unknown>
}

export const auditLog = {
  /**
   * Write an audit entry. Errors are logged but never thrown.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await db.adminAuditLog.create({
        data: {
          adminName: entry.userId,
          action: entry.action,
          target: entry.userId,
          result: 'ok',
          details: entry.metadata ?? {},
        },
      })
    } catch (err) {
      logger.error('[AuditLog] Failed to write audit entry', {
        action: entry.action,
        userId: entry.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}
