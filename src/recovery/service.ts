import crypto from 'node:crypto'
import { Keypair } from '@stellar/stellar-sdk'
import type { Prisma } from '@prisma/client'
import db from '../db'
import { closeUserSockets } from '../ws/server'
import { closeLocalUserStreams } from '../events/hub'
import { invalidateAllUserCaches } from '../utils/user-cache-invalidation'
import { publishUserEvent } from '../events/publisher'
import { logger } from '../utils/logger'
import { mailRegistry } from '../mail/mailProvider'
import { renderAccountRecoveryAlert } from '../mail/templates'

export const RECOVERY_DELAY_HOURS = 72
const RECOVERY_REQUEST_TTL_DAYS = 7

type RecoveryTx = Prisma.TransactionClient

export class RecoveryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message)
    this.name = 'RecoveryError'
  }
}

function assertWalletAddress(address: string): void {
  try {
    Keypair.fromPublicKey(address)
  } catch {
    throw new RecoveryError('Invalid Stellar public key', 400)
  }
}

async function writeAudit(
  tx: RecoveryTx,
  actorUserId: string,
  action: string,
  targetUserId: string,
  details: Prisma.InputJsonObject
): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminName: actorUserId,
      action,
      target: targetUserId,
      result: 'ok',
      details,
    },
  })
}

async function notifyUser(
  userId: string,
  email: string,
  data: {
    event:
      | 'invited'
      | 'initiated'
      | 'guardian_accepted'
      | 'approved'
      | 'cancelled'
      | 'completed'
    requestId?: string
    ownerWalletAddress?: string
    newWalletAddress?: string
    completesAt?: Date | null
    cancelToken?: string
  }
): Promise<void> {
  const { cancelToken, ...eventData } = data
  const alert = {
    ...eventData,
    completesAt: eventData.completesAt?.toISOString() ?? null,
  }
  const notifications = [
    publishUserEvent(userId, 'alerts', 'security.account_recovery', alert),
    mailRegistry.send(
      renderAccountRecoveryAlert(email, { ...alert, cancelToken })
    ),
  ]

  const results = await Promise.allSettled(notifications)
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error('[AccountRecovery] Security alert delivery failed', {
        userId,
        event: data.event,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      })
    }
  }
}

export async function listRecoveryGuardians(userId: string) {
  const [policy, invitations] = await Promise.all([
    db.recoveryPolicy.findUnique({
      where: { userId },
      include: {
        guardians: {
          select: {
            id: true,
            guardianUserId: true,
            status: true,
            invitedAt: true,
            acceptedAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    db.recoveryGuardian.findMany({
      where: { guardianUserId: userId, status: 'PENDING' },
      select: {
        id: true,
        invitedAt: true,
        policy: { select: { userId: true } },
      },
    }),
  ])
  return {
    policy: policy
      ? {
          requiredApprovals: policy.requiredApprovals,
          recoveryDelayHours: policy.recoveryDelayHours,
          guardians: policy.guardians,
        }
      : null,
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      ownerUserId: invitation.policy.userId,
      invitedAt: invitation.invitedAt,
    })),
  }
}

export async function configureRecovery(
  userId: string,
  guardianUserIds: string[],
  requiredApprovals: number
): Promise<void> {
  if (
    guardianUserIds.length < 3 ||
    guardianUserIds.length > 5 ||
    new Set(guardianUserIds).size !== guardianUserIds.length ||
    guardianUserIds.includes(userId)
  ) {
    throw new RecoveryError(
      'Choose 3 to 5 distinct guardians other than yourself',
      400
    )
  }
  if (
    !Number.isInteger(requiredApprovals) ||
    requiredApprovals < 2 ||
    requiredApprovals > guardianUserIds.length
  ) {
    throw new RecoveryError(
      'requiredApprovals must be at least 2 and no greater than the guardian count',
      400
    )
  }

  const [owner, guardians] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        walletAddress: true,
        emailIdentity: { select: { status: true } },
      },
    }),
    db.user.findMany({
      where: {
        id: { in: guardianUserIds },
        isActive: true,
        emailIdentity: { is: { status: 'VERIFIED' } },
      },
      select: {
        id: true,
        emailIdentity: { select: { email: true } },
      },
    }),
  ])
  if (!owner || owner.emailIdentity?.status !== 'VERIFIED') {
    throw new RecoveryError(
      'A verified account email is required to configure recovery',
      409
    )
  }
  if (
    guardians.length !== guardianUserIds.length ||
    guardians.some((guardian) => !guardian.emailIdentity?.email)
  ) {
    throw new RecoveryError(
      'Each guardian must be an active platform user with a verified email',
      400
    )
  }

  const now = new Date()
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`
    const existing = await tx.recoveryPolicy.findUnique({
      where: { userId },
      include: {
        requests: {
          where: { status: { in: ['PENDING', 'COOLING_OFF'] } },
          select: { id: true },
        },
      },
    })
    if (existing?.requests.length) {
      throw new RecoveryError(
        'Recovery settings cannot change while a request is active',
        409
      )
    }

    const policy = await tx.recoveryPolicy.upsert({
      where: { userId },
      create: {
        userId,
        requiredApprovals,
        recoveryDelayHours: RECOVERY_DELAY_HOURS,
      },
      update: {
        requiredApprovals,
        recoveryDelayHours: RECOVERY_DELAY_HOURS,
      },
    })
    await tx.recoveryGuardian.updateMany({
      where: { policyId: policy.id, status: { not: 'REMOVED' } },
      data: { status: 'REMOVED' },
    })
    for (const guardianUserId of guardianUserIds) {
      await tx.recoveryGuardian.upsert({
        where: {
          policyId_guardianUserId: { policyId: policy.id, guardianUserId },
        },
        create: {
          policyId: policy.id,
          guardianUserId,
          status: 'PENDING',
        },
        update: {
          status: 'PENDING',
          invitedAt: now,
          acceptedAt: null,
        },
      })
    }
    await writeAudit(
      tx,
      userId,
      'account_recovery.guardians_configured',
      userId,
      {
        guardianCount: guardianUserIds.length,
        requiredApprovals,
        recoveryDelayHours: RECOVERY_DELAY_HOURS,
        at: now.toISOString(),
      }
    )
  })

  for (const guardian of guardians) {
    await notifyUser(guardian.id, guardian.emailIdentity!.email, {
      event: 'invited',
      ownerWalletAddress: owner.walletAddress,
    })
  }
}

export async function acceptGuardianInvitation(
  guardianUserId: string,
  guardianId: string
): Promise<boolean> {
  const invitation = await db.recoveryGuardian.findFirst({
    where: { id: guardianId, guardianUserId, status: 'PENDING' },
    include: {
      policy: {
        select: {
          userId: true,
          user: {
            select: {
              emailIdentity: { select: { email: true, status: true } },
            },
          },
        },
      },
    },
  })
  if (!invitation) return false

  const updated = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${invitation.policy.userId}))`
    const activeRequest = await tx.accountRecoveryRequest.findFirst({
      where: {
        userId: invitation.policy.userId,
        status: { in: ['PENDING', 'COOLING_OFF'] },
      },
      select: { id: true },
    })
    if (activeRequest) {
      throw new RecoveryError(
        'Guardian invitations cannot be accepted while a request is active',
        409
      )
    }
    const result = await tx.recoveryGuardian.updateMany({
      where: {
        id: guardianId,
        guardianUserId,
        status: 'PENDING',
      },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    })
    if (result.count !== 1) return false
    await writeAudit(
      tx,
      guardianUserId,
      'account_recovery.guardian_accepted',
      invitation.policy.userId,
      { guardianId }
    )
    return true
  })

  if (updated && invitation.policy.user.emailIdentity?.email) {
    await notifyUser(
      invitation.policy.userId,
      invitation.policy.user.emailIdentity.email,
      { event: 'guardian_accepted' }
    )
  }
  return updated
}

export async function initiateRecovery(
  currentWalletAddress: string,
  newWalletAddress: string
): Promise<{ id: string; completesAt: Date | null }> {
  assertWalletAddress(currentWalletAddress)
  assertWalletAddress(newWalletAddress)
  if (currentWalletAddress === newWalletAddress) {
    throw new RecoveryError(
      'The new wallet must differ from the account wallet',
      400
    )
  }

  const owner = await db.user.findUnique({
    where: { walletAddress: currentWalletAddress },
    include: {
      emailIdentity: true,
      recoveryPolicy: {
        include: {
          guardians: {
            where: { status: 'ACCEPTED' },
            include: { guardian: { include: { emailIdentity: true } } },
          },
        },
      },
    },
  })
  if (!owner || !owner.recoveryPolicy) {
    throw new RecoveryError('Recovery is unavailable for this account', 404)
  }
  if (
    owner.emailIdentity?.status !== 'VERIFIED' ||
    !owner.emailIdentity.email
  ) {
    throw new RecoveryError(
      'A verified account email is required to initiate recovery',
      409
    )
  }
  const guardians = owner.recoveryPolicy.guardians
  if (
    guardians.length < 3 ||
    guardians.length > 5 ||
    guardians.length < owner.recoveryPolicy.requiredApprovals ||
    guardians.some(
      (guardian) =>
        guardian.guardian.emailIdentity?.status !== 'VERIFIED' ||
        !guardian.guardian.emailIdentity.email
    )
  ) {
    throw new RecoveryError(
      'Recovery requires 3 to 5 accepted guardians with verified emails',
      409
    )
  }
  const existingWallet = await db.user.findUnique({
    where: { walletAddress: newWalletAddress },
    select: { id: true },
  })
  if (existingWallet) {
    throw new RecoveryError(
      'The new wallet is already linked to an account',
      409
    )
  }
  const activeRequest = await db.accountRecoveryRequest.findFirst({
    where: { userId: owner.id, status: { in: ['PENDING', 'COOLING_OFF'] } },
    select: { id: true },
  })
  if (activeRequest) {
    throw new RecoveryError(
      'An account recovery request is already active',
      409
    )
  }

  const expiresAt = new Date(
    Date.now() + RECOVERY_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000
  )
  const cancelTokenExpiresAt = new Date(
    expiresAt.getTime() + RECOVERY_DELAY_HOURS * 60 * 60 * 1000
  )
  const cancelToken = crypto.randomBytes(32).toString('base64url')
  const cancelTokenHash = crypto
    .createHash('sha256')
    .update(cancelToken)
    .digest('hex')
  const request = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${owner.id}))`
    const policy = await tx.recoveryPolicy.findUnique({
      where: { userId: owner.id },
      include: {
        guardians: {
          where: { status: 'ACCEPTED' },
          include: { guardian: { include: { emailIdentity: true } } },
        },
      },
    })
    if (
      !policy ||
      policy.guardians.length < 3 ||
      policy.guardians.length > 5 ||
      policy.guardians.length < policy.requiredApprovals ||
      policy.guardians.some(
        (guardian) =>
          guardian.guardian.emailIdentity?.status !== 'VERIFIED' ||
          !guardian.guardian.emailIdentity.email
      )
    ) {
      throw new RecoveryError(
        'Recovery requires 3 to 5 accepted guardians with verified emails',
        409
      )
    }
    const activeRequest = await tx.accountRecoveryRequest.findFirst({
      where: { userId: owner.id, status: { in: ['PENDING', 'COOLING_OFF'] } },
      select: { id: true },
    })
    if (activeRequest) {
      throw new RecoveryError(
        'An account recovery request is already active',
        409
      )
    }
    const created = await tx.accountRecoveryRequest.create({
      data: {
        policyId: policy.id,
        userId: owner.id,
        currentWalletAddress,
        newWalletAddress,
        requiredApprovals: policy.requiredApprovals,
        recoveryDelayHours: RECOVERY_DELAY_HOURS,
        expiresAt,
        cancelTokenHash,
        cancelTokenExpiresAt,
      },
    })
    await writeAudit(tx, owner.id, 'account_recovery.initiated', owner.id, {
      requestId: created.id,
      guardianCount: policy.guardians.length,
      requiredApprovals: created.requiredApprovals,
      recoveryDelayHours: created.recoveryDelayHours,
    })
    return { request: created, guardians: policy.guardians }
  })

  await notifyUser(owner.id, owner.emailIdentity.email, {
    event: 'initiated',
    requestId: request.request.id,
    ownerWalletAddress: currentWalletAddress,
    newWalletAddress,
    cancelToken,
  })
  for (const guardian of request.guardians) {
    await notifyUser(
      guardian.guardianUserId,
      guardian.guardian.emailIdentity!.email,
      {
        event: 'initiated',
        requestId: request.request.id,
        ownerWalletAddress: currentWalletAddress,
        newWalletAddress,
      }
    )
  }
  return {
    id: request.request.id,
    completesAt: request.request.completesAt,
  }
}

export async function approveRecovery(
  guardianUserId: string,
  requestId: string
): Promise<{
  approvedCount: number
  requiredApprovals: number
  completesAt: Date | null
}> {
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requestId}))`
    const request = await tx.accountRecoveryRequest.findFirst({
      where: {
        id: requestId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
        policy: {
          guardians: {
            some: { guardianUserId, status: 'ACCEPTED' },
          },
        },
      },
      select: {
        id: true,
        userId: true,
        requiredApprovals: true,
        recoveryDelayHours: true,
        policy: {
          select: {
            guardians: {
              where: { guardianUserId, status: 'ACCEPTED' },
              select: { id: true },
            },
          },
        },
      },
    })
    if (!request) {
      throw new RecoveryError(
        'Recovery request is not pending or caller is not an accepted guardian',
        404
      )
    }
    const guardianId = request.policy.guardians[0]?.id
    if (!guardianId) {
      throw new RecoveryError('Guardian authorization failed', 403)
    }
    await tx.recoveryApproval.create({
      data: { requestId, guardianId },
    })
    const approvedCount = await tx.recoveryApproval.count({
      where: { requestId },
    })
    let completesAt: Date | null = null
    if (approvedCount >= request.requiredApprovals) {
      const now = new Date()
      completesAt = new Date(
        now.getTime() + request.recoveryDelayHours * 60 * 60 * 1000
      )
      await tx.accountRecoveryRequest.update({
        where: { id: requestId },
        data: {
          status: 'COOLING_OFF',
          quorumReachedAt: now,
          completesAt,
        },
      })
    }
    await writeAudit(
      tx,
      guardianUserId,
      'account_recovery.approved',
      request.userId,
      {
        requestId,
        approvedCount,
        requiredApprovals: request.requiredApprovals,
        completesAt: completesAt?.toISOString() ?? null,
      }
    )
    return {
      userId: request.userId,
      approvedCount,
      requiredApprovals: request.requiredApprovals,
      completesAt,
    }
  })
  const owner = await db.user.findUnique({
    where: { id: result.userId },
    select: { emailIdentity: { select: { email: true, status: true } } },
  })
  if (
    owner?.emailIdentity?.status === 'VERIFIED' &&
    owner.emailIdentity.email
  ) {
    await notifyUser(result.userId, owner.emailIdentity.email, {
      event: 'approved',
      requestId,
      completesAt: result.completesAt,
    })
  }
  return {
    approvedCount: result.approvedCount,
    requiredApprovals: result.requiredApprovals,
    completesAt: result.completesAt,
  }
}

export async function getRecoveryRequest(userId: string, requestId: string) {
  const request = await db.accountRecoveryRequest.findFirst({
    where: {
      id: requestId,
      OR: [
        { userId },
        {
          policy: {
            guardians: { some: { guardianUserId: userId, status: 'ACCEPTED' } },
          },
        },
      ],
    },
    select: {
      id: true,
      status: true,
      requiredApprovals: true,
      recoveryDelayHours: true,
      completesAt: true,
      expiresAt: true,
      createdAt: true,
      _count: { select: { approvals: true } },
    },
  })
  if (!request) {
    throw new RecoveryError('Recovery request not found', 404)
  }
  return {
    requestId: request.id,
    status: request.status,
    approvedCount: request._count.approvals,
    requiredApprovals: request.requiredApprovals,
    recoveryDelayHours: request.recoveryDelayHours,
    completesAt: request.completesAt,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
  }
}

export async function cancelRecovery(
  userId: string,
  requestId: string
): Promise<boolean> {
  const cancelled = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requestId}))`
    const request = await tx.accountRecoveryRequest.findFirst({
      where: {
        id: requestId,
        userId,
        status: { in: ['PENDING', 'COOLING_OFF'] },
      },
      select: { id: true },
    })
    if (!request) return false
    const changed = await tx.accountRecoveryRequest.updateMany({
      where: {
        id: requestId,
        userId,
        status: { in: ['PENDING', 'COOLING_OFF'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelTokenHash: null,
        cancelTokenExpiresAt: null,
      },
    })
    if (changed.count !== 1) return false
    await writeAudit(tx, userId, 'account_recovery.cancelled', userId, {
      requestId,
    })
    return true
  })
  if (!cancelled) return false

  const owner = await db.user.findUnique({
    where: { id: userId },
    select: {
      emailIdentity: { select: { email: true, status: true } },
      recoveryPolicy: {
        select: {
          guardians: {
            where: { status: 'ACCEPTED' },
            select: { guardianUserId: true },
          },
        },
      },
    },
  })
  if (
    owner?.emailIdentity?.status === 'VERIFIED' &&
    owner.emailIdentity.email
  ) {
    await notifyUser(userId, owner.emailIdentity.email, {
      event: 'cancelled',
      requestId,
    })
  }
  for (const guardian of owner?.recoveryPolicy?.guardians ?? []) {
    const identity = await db.emailIdentity.findUnique({
      where: { userId: guardian.guardianUserId },
      select: { email: true, status: true },
    })
    if (identity?.status === 'VERIFIED') {
      await notifyUser(guardian.guardianUserId, identity.email, {
        event: 'cancelled',
        requestId,
      })
    }
  }
  return true
}

export async function cancelRecoveryWithEmailToken(
  requestId: string,
  token: string
): Promise<boolean> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const request = await db.accountRecoveryRequest.findFirst({
    where: {
      id: requestId,
      cancelTokenHash: tokenHash,
      cancelTokenExpiresAt: { gt: new Date() },
      status: { in: ['PENDING', 'COOLING_OFF'] },
    },
    select: { userId: true },
  })
  if (!request) return false
  return cancelRecovery(request.userId, requestId)
}

async function completeRecovery(requestId: string): Promise<void> {
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requestId}))`
    const request = await tx.accountRecoveryRequest.findFirst({
      where: {
        id: requestId,
        status: 'COOLING_OFF',
        completesAt: { lte: new Date() },
      },
      select: {
        id: true,
        userId: true,
        currentWalletAddress: true,
        newWalletAddress: true,
        policyId: true,
      },
    })
    if (!request) return null

    const walletInUse = await tx.user.findUnique({
      where: { walletAddress: request.newWalletAddress },
      select: { id: true },
    })
    if (walletInUse && walletInUse.id !== request.userId) {
      await tx.accountRecoveryRequest.update({
        where: { id: request.id },
        data: {
          status: 'FAILED',
          cancelTokenHash: null,
          cancelTokenExpiresAt: null,
        },
      })
      await writeAudit(
        tx,
        request.userId,
        'account_recovery.failed',
        request.userId,
        {
          requestId,
          reason: 'new_wallet_already_linked',
        }
      )
      return null
    }

    await tx.user.update({
      where: {
        id: request.userId,
        walletAddress: request.currentWalletAddress,
      },
      data: { walletAddress: request.newWalletAddress },
    })
    const revokedAt = new Date()
    await tx.session.updateMany({
      where: { userId: request.userId, revokedAt: null },
      data: {
        revokedAt,
        revokedReason: 'account_recovery',
        refreshTokenHash: null,
        refreshTokenPrefix: null,
        refreshTokenUsedAt: null,
        refreshTokenExpiresAt: null,
      },
    })
    await tx.userApiKey.updateMany({
      where: { userId: request.userId, revokedAt: null },
      data: { revokedAt },
    })
    await tx.totpCredential.deleteMany({ where: { userId: request.userId } })
    await tx.webAuthnCredential.deleteMany({
      where: { userId: request.userId },
    })
    await tx.webAuthnChallenge.deleteMany({
      where: { userId: request.userId },
    })
    await tx.accountRecoveryRequest.update({
      where: { id: request.id },
      data: {
        status: 'COMPLETED',
        completedAt: revokedAt,
        cancelTokenHash: null,
        cancelTokenExpiresAt: null,
      },
    })
    await writeAudit(
      tx,
      request.userId,
      'account_recovery.completed',
      request.userId,
      {
        requestId,
        revokedAt: revokedAt.toISOString(),
      }
    )
    const guardians = await tx.recoveryGuardian.findMany({
      where: { policyId: request.policyId, status: 'ACCEPTED' },
      select: { guardianUserId: true },
    })
    return { userId: request.userId, guardians }
  })

  if (!result) return
  closeUserSockets(result.userId, 'Account recovery completed')
  closeLocalUserStreams(result.userId, 'Account recovery completed')
  await invalidateAllUserCaches(result.userId)
  const owner = await db.user.findUnique({
    where: { id: result.userId },
    select: { emailIdentity: { select: { email: true } } },
  })
  if (owner?.emailIdentity?.email) {
    await notifyUser(result.userId, owner.emailIdentity.email, {
      event: 'completed',
      requestId,
    })
  }
  for (const guardian of result.guardians) {
    const record = await db.emailIdentity.findUnique({
      where: { userId: guardian.guardianUserId },
      select: { email: true, status: true },
    })
    if (record?.status === 'VERIFIED') {
      await notifyUser(guardian.guardianUserId, record.email, {
        event: 'completed',
        requestId,
      })
    }
  }
}

export async function sweepAccountRecovery(now = new Date()): Promise<void> {
  const expiredRequests = await db.accountRecoveryRequest.findMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    select: { id: true, userId: true },
    orderBy: { expiresAt: 'asc' },
    take: 100,
  })
  for (const request of expiredRequests) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.id}))`
      const expired = await tx.accountRecoveryRequest.updateMany({
        where: {
          id: request.id,
          status: 'PENDING',
          expiresAt: { lte: now },
        },
        data: {
          status: 'EXPIRED',
          cancelTokenHash: null,
          cancelTokenExpiresAt: null,
        },
      })
      if (expired.count === 1) {
        await writeAudit(
          tx,
          request.userId,
          'account_recovery.expired',
          request.userId,
          { requestId: request.id, expiredAt: now.toISOString() }
        )
      }
    })
  }
  const due = await db.accountRecoveryRequest.findMany({
    where: { status: 'COOLING_OFF', completesAt: { lte: now } },
    select: { id: true },
    take: 100,
    orderBy: { completesAt: 'asc' },
  })
  for (const request of due) {
    try {
      await completeRecovery(request.id)
    } catch (error) {
      logger.error('[AccountRecovery] Failed to complete due recovery', {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
