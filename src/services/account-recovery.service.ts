import { Prisma } from '@prisma/client'
import crypto from 'node:crypto'
import db from '../db'
import { dispatchOutboundNotifications } from './outboundNotifications'
import { closeUserSockets } from '../ws/server'
import { invalidateAllUserCaches } from '../utils/user-cache-invalidation'
import { publishUserEvent } from '../events/publisher'
import { logger } from '../utils/logger'

export const RECOVERY_DELAY_HOURS = 72

export function hashRecoveryToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function lockRecoveryOwner(
  tx: Prisma.TransactionClient,
  ownerUserId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ownerUserId}))`
}

export async function queueRecoveryEmail(
  tx: Prisma.TransactionClient,
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<void> {
  await tx.outboundNotification.create({
    data: { channel: 'email', payload: { to, subject, text, html } },
  })
}

export function dispatchRecoveryNotifications(): void {
  dispatchOutboundNotifications().catch((error) =>
    logger.error('[AccountRecovery] Immediate notification dispatch failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  )
}

export async function writeRecoveryAudit(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  action: string,
  details: Prisma.InputJsonObject
): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminName: 'SYSTEM',
      action,
      target: ownerUserId,
      result: 'ok',
      details,
    },
  })
}

export async function completeRecoveryRequest(
  requestId: string
): Promise<boolean> {
  const completed = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "recovery_requests" WHERE "id" = ${requestId} FOR UPDATE`
    const request = await tx.recoveryRequest.findFirst({
      where: {
        id: requestId,
        status: 'PENDING',
        completesAt: { lte: new Date() },
      },
      include: {
        owner: {
          select: {
            id: true,
            isActive: true,
            walletAddress: true,
            emailIdentity: { select: { email: true, status: true } },
          },
        },
        approvals: true,
      },
    })
    if (!request || !request.owner.isActive) return null

    const policy = await tx.recoveryPolicy.findUnique({
      where: { ownerUserId: request.ownerUserId },
    })
    if (
      !policy ||
      request.approvals.length < policy.requiredApprovals ||
      !request.quorumReachedAt
    )
      return null

    const keyOwner = await tx.user.findFirst({
      where: {
        OR: [
          { walletAddress: request.proposedAuthPublicKey },
          { authPublicKey: request.proposedAuthPublicKey },
        ],
      },
      select: { id: true },
    })
    if (keyOwner && keyOwner.id !== request.ownerUserId) {
      await tx.recoveryRequest.update({
        where: { id: request.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationTokenHash: null,
        },
      })
      await writeRecoveryAudit(
        tx,
        request.ownerUserId,
        'RECOVERY_COMPLETION_BLOCKED',
        {
          requestId: request.id,
          reason: 'proposed_signing_key_already_assigned',
        }
      )
      return null
    }

    const now = new Date()
    await tx.user.update({
      where: { id: request.ownerUserId },
      data: { authPublicKey: request.proposedAuthPublicKey },
    })
    const [sessions, apiKeys, totp, passkeys] = await Promise.all([
      tx.session.updateMany({
        where: { userId: request.ownerUserId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: 'account_recovery',
          refreshTokenHash: null,
          refreshTokenPrefix: null,
          refreshTokenUsedAt: null,
          refreshTokenExpiresAt: null,
        },
      }),
      tx.userApiKey.updateMany({
        where: { userId: request.ownerUserId, revokedAt: null },
        data: { revokedAt: now },
      }),
      tx.totpCredential.deleteMany({ where: { userId: request.ownerUserId } }),
      tx.webAuthnCredential.deleteMany({
        where: { userId: request.ownerUserId },
      }),
    ])
    await tx.recoveryRequest.update({
      where: { id: request.id },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        cancellationTokenHash: null,
      },
    })
    await writeRecoveryAudit(tx, request.ownerUserId, 'RECOVERY_COMPLETED', {
      requestId: request.id,
      approvals: request.approvals.length,
      authPublicKeyChanged: true,
      sessionsRevoked: sessions.count,
      apiKeysRevoked: apiKeys.count,
      totpCredentialsReset: totp.count,
      passkeysRemoved: passkeys.count,
    })
    if (request.owner.emailIdentity?.status === 'VERIFIED') {
      await queueRecoveryEmail(
        tx,
        request.owner.emailIdentity.email,
        'Account recovery completed',
        'Your account access recovery is complete. All existing sessions were revoked. If you did not request this, contact support immediately.',
        '<p>Your account access recovery is complete. All existing sessions were revoked. If you did not request this, contact support immediately.</p>'
      )
    }
    return { ownerUserId: request.ownerUserId, requestId: request.id }
  })

  if (!completed) return false

  dispatchRecoveryNotifications()
  closeUserSockets(completed.ownerUserId, 'Account recovery completed')
  await invalidateAllUserCaches(completed.ownerUserId)
  await publishUserEvent(
    completed.ownerUserId,
    'alerts',
    'security.recovery_completed',
    {
      requestId: completed.requestId,
      completedAt: new Date().toISOString(),
    }
  )

  logger.warn('[AccountRecovery] Account access recovered', {
    requestId: completed.requestId,
    ownerUserId: completed.ownerUserId,
  })
  return true
}

export async function sweepDueRecoveries(): Promise<void> {
  const due = await db.recoveryRequest.findMany({
    where: { status: 'PENDING', completesAt: { lte: new Date() } },
    select: { id: true },
    take: 100,
    orderBy: { completesAt: 'asc' },
  })
  for (const request of due) {
    try {
      await completeRecoveryRequest(request.id)
    } catch (error) {
      logger.error('[AccountRecovery] Failed to complete due recovery', {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export function scheduleRecoveryCompletion(): NodeJS.Timeout {
  const timer = setInterval(() => {
    sweepDueRecoveries().catch((error) =>
      logger.error('[AccountRecovery] Recovery completion sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }, 60_000)
  timer.unref()
  return timer
}
