import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express'
import crypto from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { sensitiveRateLimiter } from '../middleware/rateLimiter'
import { validate } from '../middleware/validate'
import { publishUserEvent } from '../events/publisher'
import { stellarVerification } from '../utils/stellar/stellar-verification'
import {
  dispatchRecoveryNotifications,
  hashRecoveryToken,
  lockRecoveryOwner,
  queueRecoveryEmail,
  RECOVERY_DELAY_HOURS,
  writeRecoveryAudit,
} from '../services/account-recovery.service'
import { logger } from '../utils/logger'

const router = Router()
const emailSchema = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase())
const guardianInput = z.object({
  guardianUserId: z.string().uuid(),
  requiredApprovals: z.number().int().min(2).max(5).optional(),
})
const revokeGuardianInput = z.object({ guardianId: z.string().uuid() })
const initiateInput = z.object({
  email: emailSchema,
  newAuthPublicKey: z.string().refine(StrKey.isValidEd25519PublicKey, {
    message: 'A valid Stellar public key is required',
  }),
  signature: z.string().min(1).max(512),
})
const idParams = z.object({ id: z.string().uuid() })
const cancelInput = z.object({
  requestId: z.string().uuid(),
  token: z.string().min(32).max(256),
})

const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch((error: unknown) => next(error))
  }

function fail(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function isHttpError(error: unknown): error is Error & { status: number } {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number'
  )
}

async function cancelRequest(
  requestId: string,
  ownerUserId?: string,
  token?: string
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "recovery_requests" WHERE "id" = ${requestId} FOR UPDATE`
    const request = await tx.recoveryRequest.findFirst({
      where: { id: requestId, status: 'PENDING' },
      select: {
        id: true,
        ownerUserId: true,
        cancellationTokenHash: true,
        completedAt: true,
      },
    })
    if (!request || request.completedAt) return false

    if (ownerUserId) {
      if (request.ownerUserId !== ownerUserId) return false
    } else if (
      !token ||
      !request.cancellationTokenHash ||
      !crypto.timingSafeEqual(
        Buffer.from(hashRecoveryToken(token), 'hex'),
        Buffer.from(request.cancellationTokenHash, 'hex')
      )
    ) {
      return false
    }

    const now = new Date()
    await tx.recoveryRequest.update({
      where: { id: request.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancellationTokenHash: null,
      },
    })
    await writeRecoveryAudit(tx, request.ownerUserId, 'RECOVERY_CANCELLED', {
      requestId: request.id,
      cancellationChannel: ownerUserId
        ? 'authenticated_session'
        : 'email_token',
    })
    return true
  })
}

router.get(
  '/guardians',
  requireAuth,
  handle(async (req, res) => {
    const userId = req.auth!.userId
    const [policy, nominated, incoming] = await Promise.all([
      db.recoveryPolicy.findUnique({ where: { ownerUserId: userId } }),
      db.recoveryGuardian.findMany({
        where: { ownerUserId: userId, revokedAt: null },
        include: {
          guardianUser: {
            select: {
              id: true,
              displayName: true,
              emailIdentity: { select: { email: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.recoveryGuardian.findMany({
        where: { guardianUserId: userId, acceptedAt: null, revokedAt: null },
        include: { owner: { select: { id: true, displayName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ])
    res.json({
      policy: policy
        ? {
            requiredApprovals: policy.requiredApprovals,
            recoveryDelayHours: RECOVERY_DELAY_HOURS,
          }
        : null,
      guardians: nominated,
      nominations: incoming,
    })
  })
)

router.get(
  '/requests',
  requireAuth,
  handle(async (req, res) => {
    const userId = req.auth!.userId
    const guardianships = await db.recoveryGuardian.findMany({
      where: {
        guardianUserId: userId,
        acceptedAt: { not: null },
        revokedAt: null,
      },
      select: { ownerUserId: true },
    })
    const requests = await db.recoveryRequest.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { ownerUserId: userId },
          { ownerUserId: { in: guardianships.map((row) => row.ownerUserId) } },
        ],
      },
      include: {
        _count: { select: { approvals: true } },
        owner: { select: { id: true, displayName: true } },
      },
      orderBy: { initiatedAt: 'desc' },
    })
    res.json({
      requests: requests.map((request) => ({
        id: request.id,
        owner: request.ownerUserId === userId ? undefined : request.owner,
        proposedAuthPublicKey:
          request.ownerUserId === userId
            ? request.proposedAuthPublicKey
            : undefined,
        initiatedAt: request.initiatedAt,
        quorumReachedAt: request.quorumReachedAt,
        completesAt: request.completesAt,
        approvalCount: request._count.approvals,
      })),
    })
  })
)

router.post(
  '/guardians',
  requireAuth,
  sensitiveRateLimiter,
  validate({ body: guardianInput }),
  handle(async (req, res) => {
    const ownerUserId = req.auth!.userId
    const { guardianUserId, requiredApprovals } = guardianInput.parse(req.body)
    if (guardianUserId === ownerUserId)
      throw fail(400, 'You cannot nominate yourself')

    const guardian = await db.user.findUnique({
      where: { id: guardianUserId },
      select: {
        id: true,
        isActive: true,
        emailIdentity: { select: { email: true, status: true } },
      },
    })
    if (!guardian?.isActive) throw fail(404, 'Eligible guardian not found')
    if (guardian.emailIdentity?.status !== 'VERIFIED')
      throw fail(400, 'Guardians must have a verified email address')
    const guardianEmail = guardian.emailIdentity.email

    const nomination = await db.$transaction(async (tx) => {
      await lockRecoveryOwner(tx, ownerUserId)
      const [currentPolicy, currentGuardians, activeRequest] =
        await Promise.all([
          tx.recoveryPolicy.findUnique({ where: { ownerUserId } }),
          tx.recoveryGuardian.findMany({
            where: { ownerUserId, revokedAt: null },
            select: { id: true, guardianUserId: true },
          }),
          tx.recoveryRequest.findFirst({
            where: { ownerUserId, status: 'PENDING' },
            select: { id: true },
          }),
        ])
      if (activeRequest)
        throw fail(409, 'Guardians cannot change during recovery')
      if (
        currentGuardians.some((item) => item.guardianUserId === guardianUserId)
      )
        throw fail(409, 'This user is already nominated')
      if (currentGuardians.length >= 5)
        throw fail(400, 'A maximum of five guardians is allowed')
      const quorum = requiredApprovals ?? currentPolicy?.requiredApprovals ?? 2
      if (quorum < 2 || quorum > 5)
        throw fail(400, 'Required approvals must be between two and five')
      const row = await tx.recoveryGuardian.create({
        data: { ownerUserId, guardianUserId },
      })
      await tx.recoveryPolicy.upsert({
        where: { ownerUserId },
        create: {
          ownerUserId,
          requiredApprovals: quorum,
          recoveryDelayHours: RECOVERY_DELAY_HOURS,
        },
        update: { requiredApprovals: quorum },
      })
      await writeRecoveryAudit(tx, ownerUserId, 'RECOVERY_GUARDIAN_NOMINATED', {
        guardianUserId,
        guardianId: row.id,
        requiredApprovals: quorum,
      })
      await queueRecoveryEmail(
        tx,
        guardianEmail,
        'You have been nominated as an account recovery guardian',
        'A NeuroWealth user nominated you as a recovery guardian. Sign in to your account and explicitly accept or decline the nomination in Account Recovery settings. Do not accept unless you know and trust this user.',
        '<p>A NeuroWealth user nominated you as an account recovery guardian. Sign in and explicitly accept or decline in Account Recovery settings. Do not accept unless you know and trust this user.</p>'
      )
      return { guardian: row, requiredApprovals: quorum }
    })

    dispatchRecoveryNotifications()
    await publishUserEvent(
      guardianUserId,
      'alerts',
      'security.recovery_guardian_invited',
      {
        guardianId: nomination.guardian.id,
      }
    )
    res.status(201).json(nomination)
  })
)

router.post(
  '/guardians/:id/accept',
  requireAuth,
  sensitiveRateLimiter,
  validate({ params: idParams }),
  handle(async (req, res) => {
    const guardian = await db.recoveryGuardian.findFirst({
      where: {
        id: req.params.id,
        guardianUserId: req.auth!.userId,
        revokedAt: null,
        acceptedAt: null,
      },
      include: { owner: { select: { id: true } } },
    })
    if (!guardian) throw fail(404, 'Pending guardian nomination not found')
    const email = await db.emailIdentity.findUnique({
      where: { userId: req.auth!.userId },
      select: { status: true },
    })
    if (email?.status !== 'VERIFIED')
      throw fail(
        403,
        'A verified email address is required to accept a nomination'
      )

    const acceptedAt = new Date()
    await db.$transaction(async (tx) => {
      await lockRecoveryOwner(tx, guardian.ownerUserId)
      const pending = await tx.recoveryGuardian.findFirst({
        where: {
          id: guardian.id,
          guardianUserId: req.auth!.userId,
          acceptedAt: null,
          revokedAt: null,
        },
      })
      if (!pending) throw fail(404, 'Pending guardian nomination not found')
      await tx.recoveryGuardian.update({
        where: { id: pending.id },
        data: { acceptedAt },
      })
      await writeRecoveryAudit(
        tx,
        guardian.ownerUserId,
        'RECOVERY_GUARDIAN_ACCEPTED',
        {
          guardianId: guardian.id,
          guardianUserId: req.auth!.userId,
        }
      )
    })
    await publishUserEvent(
      guardian.ownerUserId,
      'alerts',
      'security.recovery_guardian_accepted',
      {
        guardianId: guardian.id,
      }
    )
    res.json({ guardianId: guardian.id, acceptedAt })
  })
)

router.post(
  '/guardians/:id/decline',
  requireAuth,
  sensitiveRateLimiter,
  validate({ params: idParams }),
  handle(async (req, res) => {
    const guardian = await db.recoveryGuardian.findFirst({
      where: {
        id: req.params.id,
        guardianUserId: req.auth!.userId,
        acceptedAt: null,
        revokedAt: null,
      },
    })
    if (!guardian) throw fail(404, 'Pending guardian nomination not found')
    await db.$transaction(async (tx) => {
      await lockRecoveryOwner(tx, guardian.ownerUserId)
      const pending = await tx.recoveryGuardian.findFirst({
        where: {
          id: guardian.id,
          guardianUserId: req.auth!.userId,
          acceptedAt: null,
          revokedAt: null,
        },
      })
      if (!pending) throw fail(404, 'Pending guardian nomination not found')
      await tx.recoveryGuardian.update({
        where: { id: pending.id },
        data: { revokedAt: new Date() },
      })
      await writeRecoveryAudit(
        tx,
        guardian.ownerUserId,
        'RECOVERY_GUARDIAN_DECLINED',
        {
          guardianId: guardian.id,
          guardianUserId: req.auth!.userId,
        }
      )
    })
    res.status(204).end()
  })
)

router.post(
  '/guardians/revoke',
  requireAuth,
  sensitiveRateLimiter,
  validate({ body: revokeGuardianInput }),
  handle(async (req, res) => {
    const { guardianId } = revokeGuardianInput.parse(req.body)
    const guardian = await db.recoveryGuardian.findFirst({
      where: {
        id: guardianId,
        ownerUserId: req.auth!.userId,
        revokedAt: null,
      },
    })
    if (!guardian) throw fail(404, 'Guardian not found')
    const activeRequest = await db.recoveryRequest.findFirst({
      where: { ownerUserId: req.auth!.userId, status: 'PENDING' },
      select: { id: true },
    })
    if (activeRequest)
      throw fail(409, 'Guardians cannot change during recovery')
    await db.$transaction(async (tx) => {
      await lockRecoveryOwner(tx, req.auth!.userId)
      const activeRequest = await tx.recoveryRequest.findFirst({
        where: { ownerUserId: req.auth!.userId, status: 'PENDING' },
        select: { id: true },
      })
      if (activeRequest)
        throw fail(409, 'Guardians cannot change during recovery')
      const activeGuardian = await tx.recoveryGuardian.findFirst({
        where: {
          id: guardian.id,
          ownerUserId: req.auth!.userId,
          revokedAt: null,
        },
      })
      if (!activeGuardian) throw fail(404, 'Guardian not found')
      await tx.recoveryGuardian.update({
        where: { id: activeGuardian.id },
        data: { revokedAt: new Date() },
      })
      await writeRecoveryAudit(
        tx,
        req.auth!.userId,
        'RECOVERY_GUARDIAN_REVOKED',
        {
          guardianId: guardian.id,
        }
      )
    })
    res.status(204).end()
  })
)

router.post(
  '/initiate',
  sensitiveRateLimiter,
  validate({ body: initiateInput }),
  handle(async (req, res) => {
    const { email, newAuthPublicKey, signature } = initiateInput.parse(req.body)
    const genericResponse = {
      accepted: true,
      message:
        'If the account is eligible, recovery instructions have been sent to its registered email address.',
    }
    const challenge = await db.authNonce.findUnique({
      where: { stellarPubKey: newAuthPublicKey },
    })
    if (
      !challenge ||
      challenge.expiresAt <= new Date() ||
      !stellarVerification.verifyStellarSignature(
        newAuthPublicKey,
        challenge.nonce,
        signature
      )
    ) {
      res.status(202).json(genericResponse)
      return
    }
    const consumed = await db.authNonce.deleteMany({
      where: {
        stellarPubKey: newAuthPublicKey,
        nonce: challenge.nonce,
        expiresAt: { gt: new Date() },
      },
    })
    if (consumed.count !== 1) {
      res.status(202).json(genericResponse)
      return
    }

    const identity = await db.emailIdentity.findUnique({
      where: { email },
      include: {
        user: {
          select: {
            id: true,
            isActive: true,
            walletAddress: true,
            authPublicKey: true,
          },
        },
      },
    })
    if (
      !identity ||
      identity.status !== 'VERIFIED' ||
      !identity.user.isActive ||
      identity.user.walletAddress === newAuthPublicKey ||
      identity.user.authPublicKey === newAuthPublicKey
    ) {
      res.status(202).json(genericResponse)
      return
    }

    const existing = await db.user.findFirst({
      where: {
        OR: [
          { walletAddress: newAuthPublicKey },
          { authPublicKey: newAuthPublicKey },
        ],
      },
      select: { id: true },
    })
    if (existing) {
      res.status(202).json(genericResponse)
      return
    }
    const cancellationToken = crypto.randomBytes(32).toString('hex')
    const initiation = await db.$transaction(async (tx) => {
      await lockRecoveryOwner(tx, identity.userId)
      const [policy, guardians, pending] = await Promise.all([
        tx.recoveryPolicy.findUnique({
          where: { ownerUserId: identity.userId },
        }),
        tx.recoveryGuardian.findMany({
          where: {
            ownerUserId: identity.userId,
            acceptedAt: { not: null },
            revokedAt: null,
          },
          include: {
            guardianUser: {
              select: {
                emailIdentity: { select: { email: true, status: true } },
              },
            },
          },
        }),
        tx.recoveryRequest.findFirst({
          where: { ownerUserId: identity.userId, status: 'PENDING' },
          select: { id: true },
        }),
      ])
      if (
        pending ||
        !policy ||
        guardians.length < policy.requiredApprovals ||
        guardians.some(
          (guardian) =>
            guardian.guardianUser.emailIdentity?.status !== 'VERIFIED'
        )
      )
        return null

      const row = await tx.recoveryRequest.create({
        data: {
          ownerUserId: identity.userId,
          proposedAuthPublicKey: newAuthPublicKey,
          cancellationTokenHash: hashRecoveryToken(cancellationToken),
        },
      })
      await writeRecoveryAudit(tx, identity.userId, 'RECOVERY_INITIATED', {
        requestId: row.id,
        proposedAuthPublicKey: newAuthPublicKey,
      })
      const cancelUrl = `${process.env.APP_URL || 'https://neurowealth.app'}/recovery/cancel?requestId=${encodeURIComponent(row.id)}&token=${encodeURIComponent(cancellationToken)}`
      const ownerNotice =
        `An account access recovery was requested. If you did not request this, cancel it immediately: ${cancelUrl}. ` +
        `Recovery cannot take effect until ${RECOVERY_DELAY_HOURS} hours after guardian quorum is reached.`
      const guardianNotice = `An account recovery request has been initiated for a user who nominated you. Sign in to NeuroWealth to review and explicitly approve or reject it. Recovery has a mandatory ${RECOVERY_DELAY_HOURS}-hour delay after quorum.`
      await queueRecoveryEmail(
        tx,
        identity.email,
        'Important: account recovery requested',
        ownerNotice,
        `<p>An account access recovery was requested. If you did not request this, <a href="${cancelUrl}">cancel it immediately</a>.</p><p>Recovery cannot take effect until ${RECOVERY_DELAY_HOURS} hours after guardian quorum is reached.</p>`
      )
      for (const guardianEmail of guardians.map(
        (guardian) => guardian.guardianUser.emailIdentity!.email
      )) {
        await queueRecoveryEmail(
          tx,
          guardianEmail,
          'Account recovery approval requested',
          guardianNotice,
          `<p>${guardianNotice}</p>`
        )
      }
      return {
        request: row,
      }
    })
    if (!initiation) {
      res.status(202).json(genericResponse)
      return
    }

    dispatchRecoveryNotifications()
    await publishUserEvent(
      identity.userId,
      'alerts',
      'security.recovery_requested',
      {
        requestId: initiation.request.id,
        initiatedAt: initiation.request.initiatedAt.toISOString(),
      }
    )
    res.status(202).json(genericResponse)
  })
)

router.post(
  '/:id/approve',
  requireAuth,
  sensitiveRateLimiter,
  validate({ params: idParams }),
  handle(async (req, res) => {
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "recovery_requests" WHERE "id" = ${req.params.id} FOR UPDATE`
      const recovery = await tx.recoveryRequest.findFirst({
        where: { id: req.params.id, status: 'PENDING' },
        select: { id: true, ownerUserId: true, quorumReachedAt: true },
      })
      if (!recovery) throw fail(404, 'Pending recovery request not found')
      if (recovery.ownerUserId === req.auth!.userId)
        throw fail(403, 'Account owners cannot approve their own recovery')
      const guardian = await tx.recoveryGuardian.findFirst({
        where: {
          ownerUserId: recovery.ownerUserId,
          guardianUserId: req.auth!.userId,
          acceptedAt: { not: null },
          revokedAt: null,
        },
      })
      if (!guardian)
        throw fail(403, 'You are not an accepted guardian for this account')
      const approval = await tx.recoveryApproval.create({
        data: { requestId: recovery.id, guardianId: guardian.id },
      })
      const [count, policy] = await Promise.all([
        tx.recoveryApproval.count({ where: { requestId: recovery.id } }),
        tx.recoveryPolicy.findUnique({
          where: { ownerUserId: recovery.ownerUserId },
        }),
      ])
      if (!policy) throw fail(409, 'Recovery policy is unavailable')
      let completesAt: Date | null = null
      if (!recovery.quorumReachedAt && count >= policy.requiredApprovals) {
        const quorumReachedAt = new Date()
        completesAt = new Date(
          quorumReachedAt.getTime() + RECOVERY_DELAY_HOURS * 60 * 60 * 1000
        )
        await tx.recoveryRequest.update({
          where: { id: recovery.id },
          data: { quorumReachedAt, completesAt },
        })
      }
      await writeRecoveryAudit(
        tx,
        recovery.ownerUserId,
        'RECOVERY_APPROVAL_RECORDED',
        {
          requestId: recovery.id,
          guardianId: guardian.id,
          approvalId: approval.id,
          approvalCount: count,
          quorumReached: count >= policy.requiredApprovals,
        }
      )
      return {
        approval,
        count,
        requiredApprovals: policy.requiredApprovals,
        completesAt,
      }
    })
    res.status(201).json(result)
  })
)

router.post(
  '/:id/reject',
  requireAuth,
  sensitiveRateLimiter,
  validate({ params: idParams }),
  handle(async (req, res) => {
    const ownerUserId = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "recovery_requests" WHERE "id" = ${req.params.id} FOR UPDATE`
      const request = await tx.recoveryRequest.findFirst({
        where: { id: req.params.id, status: 'PENDING' },
        select: { id: true, ownerUserId: true },
      })
      if (!request) throw fail(404, 'Pending recovery request not found')
      const guardian = await tx.recoveryGuardian.findFirst({
        where: {
          ownerUserId: request.ownerUserId,
          guardianUserId: req.auth!.userId,
          acceptedAt: { not: null },
          revokedAt: null,
        },
      })
      if (!guardian)
        throw fail(403, 'You are not an accepted guardian for this account')
      await tx.recoveryRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          cancellationTokenHash: null,
        },
      })
      await writeRecoveryAudit(tx, request.ownerUserId, 'RECOVERY_REJECTED', {
        requestId: request.id,
        guardianId: guardian.id,
      })
      const identity = await tx.emailIdentity.findUnique({
        where: { userId: request.ownerUserId },
        select: { email: true, status: true },
      })
      if (identity?.status === 'VERIFIED') {
        await queueRecoveryEmail(
          tx,
          identity.email,
          'Account recovery request rejected',
          'A nominated guardian rejected your account recovery request. The request cannot complete. Contact your guardians or initiate a new request if needed.',
          '<p>A nominated guardian rejected your account recovery request. The request cannot complete. Contact your guardians or initiate a new request if needed.</p>'
        )
      }
      return request.ownerUserId
    })
    dispatchRecoveryNotifications()
    await publishUserEvent(
      ownerUserId,
      'alerts',
      'security.recovery_rejected',
      {
        requestId: req.params.id,
        rejectedAt: new Date().toISOString(),
      }
    )
    res.json({ rejected: true })
  })
)

router.post(
  '/:id/cancel',
  requireAuth,
  sensitiveRateLimiter,
  validate({ params: idParams }),
  handle(async (req, res) => {
    const cancelled = await cancelRequest(req.params.id, req.auth!.userId)
    if (!cancelled) throw fail(404, 'Pending recovery request not found')
    res.json({ cancelled: true })
  })
)

router.post(
  '/cancel',
  sensitiveRateLimiter,
  validate({ body: cancelInput }),
  handle(async (req, res) => {
    const { requestId, token } = cancelInput.parse(req.body)
    const cancelled = await cancelRequest(requestId, undefined, token)
    if (!cancelled) throw fail(404, 'Pending recovery request not found')
    res.json({ cancelled: true })
  })
)

router.use(
  (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (isHttpError(error)) {
      res.status(error.status).json({ error: error.message })
      return
    }
    logger.error('[AccountRecovery] Request failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    next(error)
  }
)

export default router
