/**
 * Security notification service (#abf9a99).
 *
 * Dispatches security-sensitive alerts (e.g. 2FA disabled, new login from
 * unknown device) to users via the outbound notification queue.
 * Errors are swallowed and reported to the app logger to prevent a
 * notification failure from blocking the primary security action.
 */

import { logger } from '../utils/logger'

export type SecurityEventType =
  | '2fa.disabled'
  | '2fa.enabled'
  | 'session.new_device'
  | 'session.revoked'
  | 'session.revoke_others'
  | 'password.changed'
  | 'passkey.registered'
  | 'passkey.deleted'
  | 'passkey.anomaly'

/**
 * Fire a security notification to the user. Non-blocking — a failure is
 * logged but never thrown.
 *
 * Currently emits to the application log only; a future PR will wire this
 * into the outbound notification queue once a 'security' channel is defined.
 */
export async function notifySecurityEvent(
  userId: string,
  eventType: SecurityEventType,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    logger.info('[SecurityNotification] Security event', {
      userId,
      eventType,
      ...metadata,
    })
  } catch (err) {
    logger.error('[SecurityNotification] Failed to dispatch security event', {
      userId,
      eventType,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
