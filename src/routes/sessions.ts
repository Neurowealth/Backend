import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { requireSessionAuth } from '../middleware/apiKeyAuth'
import { validate } from '../middleware/validate'
import { sendNotFound } from '../utils/errors'
import {
  buildPaginationMeta,
  getPaginationParams,
  paginationSchema,
} from '../utils/pagination'
import { maskIpAddress } from '../utils/geoip'
import { revokeSession } from '../services/refresh-token.service'
import { stellarVerification } from '../utils/stellar/stellar-verification'
import { logger } from '../utils/logger'
import { requireFreshSignature } from '../middleware/requireFreshSignature'
import { auditLog } from '../services/audit-log.service'
import { notifySecurityEvent } from '../services/security-notification.service'
import { totpService } from '../services/totp.service'

const router = Router()
const prisma = db

router.use(requireAuth)
router.use(requireSessionAuth)

const sessionIdParam = z.object({ id: z.string().uuid() })
const labelBody = z.object({ label: z.string().min(1).max(100) })
const revokeOthersBody = z.object({
  stellarPubKey: z.string(),
  signature: z.string(),
  nonce: z.string(),
})

const disable2faBody = z.object({
  stellarPubKey: z.string(),
  signature: z.string(),
  nonce: z.string(),
})

function formatSession(
  session: Record<string, unknown>,
  currentSessionId: string,
  showFullIp: boolean
) {
  const ip = session.ipAddress as string | null
  return {
    id: session.id,
    label: session.label,
    deviceType: session.deviceType,
    approxLocation: session.approxLocation,
    ipAddress: showFullIp ? ip : maskIpAddress(ip),
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    revokedAt: session.revokedAt,
    current: session.id === currentSessionId,
  }
}

/** GET /api/v1/sessions */
router.get(
  '/',
  validate({
    query: paginationSchema.extend({
      fullIp: z.enum(['true', 'false']).default('false'),
      sortBy: z
        .enum(['lastSeenAt', 'createdAt', 'expiresAt'])
        .default('lastSeenAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    }),
  }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const currentSessionId = req.auth!.sessionId
    const { page, limit, skip } = getPaginationParams(req.query)
    const query = req.query as {
      fullIp: 'true' | 'false'
      sortBy: 'lastSeenAt' | 'createdAt' | 'expiresAt'
      sortOrder: 'asc' | 'desc'
    }
    const showFullIp = query.fullIp === 'true'
    const where = { userId, revokedAt: null, expiresAt: { gt: new Date() } }

    const [total, sessions] = await Promise.all([
      prisma.session.count({ where }),
      prisma.session.findMany({
        where,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'desc' }],
        skip,
        take: limit,
      }),
    ])

    return res.status(200).json({
      ...buildPaginationMeta(page, limit, total),
      sessions: sessions.map((s: Record<string, unknown>) =>
        formatSession(s, currentSessionId, showFullIp)
      ),
    })
  }
)

/** PATCH /api/v1/sessions/:id — set label */
router.patch(
  '/:id',
  validate({ params: sessionIdParam, body: labelBody }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.session.findFirst({
      where: { id: req.params.id, userId, revokedAt: null },
    })
    if (!existing) return sendNotFound(res, 'Session')

    const updated = await prisma.session.update({
      where: { id: req.params.id },
      data: { label: req.body.label },
    })

    return res.status(200).json({
      id: updated.id,
      label: updated.label,
    })
  }
)

/** DELETE /api/v1/sessions/:id — revoke one session */
router.delete(
  '/:id',
  validate({ params: sessionIdParam }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const currentSessionId = req.auth!.sessionId
    const existing = await prisma.session.findFirst({
      where: { id: req.params.id, userId, revokedAt: null },
    })
    if (!existing) return sendNotFound(res, 'Session')

    // #472: revokeSession() clears the refresh material, so a refresh token
    // captured before this call cannot resurrect the session.
    await revokeSession(req.params.id, 'user', {
      userId,
      deviceType: existing.deviceType,
      approxLocation: existing.approxLocation,
    })

    const isCurrent = req.params.id === currentSessionId
    return res.status(200).json({
      id: req.params.id,
      status: 'revoked',
      current: isCurrent,
      message: isCurrent
        ? 'Current session revoked; please sign in again'
        : undefined,
    })
  }
)

/**
 * POST /api/v1/sessions/2fa/disable — disable TOTP 2FA.
 *
 * Disabling 2FA is a security downgrade, so it requires a fresh
 * wallet-signature challenge (proof-of-control), not merely an active
 * session — the session itself could be the compromised asset.
 */
router.post(
  '/2fa/disable',
  validate({ body: disable2faBody }),
  requireFreshSignature(),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const { stellarPubKey, signature, nonce } = req.body

    const isValid = stellarVerification.verifyStellarSignature(
      stellarPubKey,
      nonce,
      signature
    )
    if (!isValid) {
      return res.status(401).json({ error: 'Step-up authentication failed' })
    }

    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user || user.walletAddress !== stellarPubKey) {
      return res.status(401).json({ error: 'Step-up authentication failed' })
    }

    const credential = await prisma.totpCredential.findUnique({
      where: { userId },
    })
    if (!credential || !credential.verifiedAt) {
      return res.status(404).json({ error: 'No active 2FA credential' })
    }

    await prisma.totpCredential.delete({ where: { userId } })

    await auditLog.record({
      userId,
      action: '2fa.disabled',
      metadata: { method: 'totp' },
    })
    await notifySecurityEvent(userId, '2fa.disabled', {
      method: 'totp',
    })

    logger.info('[2FA] Disabled', { userId })

    return res.status(200).json({ status: 'disabled' })
  }
)

/** POST /api/v1/sessions/revoke-others — revoke all except current (step-up) */
router.post(
  '/revoke-others',
  validate({ body: revokeOthersBody }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const currentSessionId = req.auth!.sessionId
    const { stellarPubKey, signature, nonce } = req.body

    const isValid = stellarVerification.verifyStellarSignature(
      stellarPubKey,
      nonce,
      signature
    )
    if (!isValid) {
      return res.status(401).json({ error: 'Step-up authentication failed' })
    }

    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user || user.walletAddress !== stellarPubKey) {
      return res.status(401).json({ error: 'Step-up authentication failed' })
    }

    // #472: revoke every other session's refresh material too, not just the
    // row flag. updateMany cannot express the per-row column reset that
    // revokeSession() performs, so do it in one statement and let the service's
    // semantics (clear refresh columns, stamp revokedAt) apply to all rows.
    const others = await prisma.session.findMany({
      where: {
        userId,
        id: { not: currentSessionId },
        revokedAt: null,
      },
      select: { id: true, deviceType: true, approxLocation: true },
    })

    await Promise.all(
      others.map((session) =>
        revokeSession(session.id, 'logout_others', {
          userId,
          deviceType: session.deviceType,
          approxLocation: session.approxLocation,
        })
      )
    )

    logger.info('[Sessions] Revoke-others completed', {
      userId,
      count: others.length,
    })

    return res.status(200).json({ revokedCount: others.length })
  }
)

export default router
