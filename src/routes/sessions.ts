import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { requireSessionAuth } from '../middleware/apiKeyAuth'
import { validate } from '../middleware/validate'
import { sendNotFound } from '../utils/errors'
import { maskIpAddress } from '../utils/geoip'
import { closeUserSockets } from '../ws/server'
import { stellarVerification } from '../utils/stellar/stellar-verification'
import { logger } from '../utils/logger'

const router = Router()
const prisma = db as any

router.use(requireAuth)
router.use(requireSessionAuth)

const sessionIdParam = z.object({ id: z.string().uuid() })
const labelBody = z.object({ label: z.string().min(1).max(100) })
const revokeOthersBody = z.object({
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
router.get('/', async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const currentSessionId = req.auth!.sessionId
  const showFullIp = req.query.fullIp === 'true'

  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
  })

  return res.status(200).json({
    sessions: sessions.map((s: Record<string, unknown>) =>
      formatSession(s, currentSessionId, showFullIp)
    ),
  })
})

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

    await prisma.session.update({
      where: { id: req.params.id },
      data: { revokedAt: new Date(), revokedReason: 'user' },
    })

    closeUserSockets(userId, 'Session revoked')

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

    const result = await prisma.session.updateMany({
      where: {
        userId,
        id: { not: currentSessionId },
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedReason: 'logout_others' },
    })

    closeUserSockets(userId, 'Other sessions revoked')

    logger.info('[Sessions] Revoke-others completed', {
      userId,
      count: result.count,
    })

    return res.status(200).json({ revokedCount: result.count })
  }
)

export default router
