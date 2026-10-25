import db from '../db'
import { logger } from '../utils/logger'
import {
  generateImpersonationToken,
  verifyImpersonationToken,
  type ImpersonationContext,
} from '../middleware/impersonation'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'

export async function startImpersonation(
  adminId: string,
  adminName: string,
  targetUserId: string,
  options?: { ipAddress?: string; reason?: string; userAgent?: string }
): Promise<{ success: boolean; token?: string; sessionId?: string; error?: string }> {
  try {
    const targetUser = await db.user.findUnique({
      where: { id: targetUserId },
    })

    if (!targetUser) {
      return { success: false, error: 'Target user not found' }
    }

    const token = generateImpersonationToken(adminId, adminName, targetUserId, {
      ipAddress: options?.ipAddress,
      reason: options?.reason,
    })

    // Decode sessionId from generated token for audit record
    const { sessionId } = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString()
    ) as { sessionId: string }

    await (db as any).adminAuditLog.create({
      data: {
        action: 'impersonation.start',
        target: targetUserId,
        result: 'success',
        details: {
          adminName,
          sessionId,
          reason: options?.reason ?? null,
          ttlMinutes: 30,
        },
        ipAddress: options?.ipAddress ?? null,
        userAgent: options?.userAgent ?? null,
      },
    })

    logger.info('[AdminImpersonation] Session started', {
      adminId,
      adminName,
      targetUserId,
      sessionId,
      ipAddress: options?.ipAddress,
    })

    await publishUserEvent(
      targetUserId,
      'account',
      'account.impersonation_started',
      {
        adminId,
        adminName,
        sessionId,
        startedAt: new Date().toISOString(),
      }
    )

    return { success: true, token, sessionId }
  } catch (error) {
    logger.error('[AdminImpersonation] Failed to start impersonation', {
      adminId,
      targetUserId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { success: false, error: 'Failed to start impersonation' }
  }
}

export async function endImpersonation(
  sessionId: string,
  options?: { adminId?: string; targetUserId?: string; ipAddress?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    await (db as any).adminAuditLog.create({
      data: {
        action: 'impersonation.end',
        target: options?.targetUserId ?? null,
        result: 'success',
        details: { sessionId },
        ipAddress: options?.ipAddress ?? null,
      },
    })

    logger.info('[AdminImpersonation] Session ended', {
      sessionId,
      adminId: options?.adminId,
      targetUserId: options?.targetUserId,
    })

    return { success: true }
  } catch (error) {
    logger.error('[AdminImpersonation] Failed to end impersonation', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { success: false, error: 'Failed to end impersonation' }
  }
}
