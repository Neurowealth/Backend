import { Router, Request, Response } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import {
  generateUserApiKeyToken,
  hashApiKeyToken,
  deriveApiKeyPrefix,
  requireSessionAuth,
} from '../middleware/apiKeyAuth'
import { validate } from '../middleware/validate'
import { sendNotFound } from '../utils/errors'
import { config } from '../config'
import { logger } from '../utils/logger'
import { validateUserScopes, USER_SCOPES, type UserScope } from '../auth/scopes'
import { publishUserEvent } from '../events/publisher'

const router = Router()
const prisma = db as any

router.use(requireAuth)
router.use(requireSessionAuth)

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).min(1),
  ipAllowlist: z.array(z.string()).optional(),
  rateLimitPerMin: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  allowWithdrawals: z.boolean().optional(),
})

const keyIdParamSchema = z.object({
  id: z.string().uuid(),
})

/** POST /api/v1/keys — create a scoped API key; secret shown once. */
router.post(
  '/',
  validate({ body: createKeySchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const {
      name,
      scopes,
      ipAllowlist,
      rateLimitPerMin,
      expiresAt,
      allowWithdrawals,
    } = req.body as {
      name: string
      scopes: string[]
      ipAllowlist?: string[]
      rateLimitPerMin?: number
      expiresAt?: string
      allowWithdrawals?: boolean
    }

    if (!validateUserScopes(scopes)) {
      return res.status(400).json({
        error: 'Invalid scopes',
        validScopes: USER_SCOPES,
      })
    }

    if (scopes.includes('withdraw:write') && !allowWithdrawals) {
      return res.status(400).json({
        error: 'withdraw:write scope requires allowWithdrawals: true',
      })
    }

    const activeCount = await prisma.userApiKey.count({
      where: { userId, revokedAt: null },
    })
    if (activeCount >= config.apiKeys.maxActivePerUser) {
      return res.status(409).json({
        error: 'Maximum active API keys reached',
        limit: config.apiKeys.maxActivePerUser,
      })
    }

    const keyId = crypto.randomUUID()
    const secret = crypto.randomBytes(32).toString('hex')
    const rawToken = generateUserApiKeyToken(keyId, secret)
    const hash = await hashApiKeyToken(rawToken)
    const tokenPrefix = deriveApiKeyPrefix(rawToken)

    const key = await prisma.userApiKey.create({
      data: {
        id: keyId,
        userId,
        name,
        scopes,
        hash,
        tokenPrefix,
        ipAllowlist: ipAllowlist ?? [],
        rateLimitPerMin: rateLimitPerMin ?? null,
        allowWithdrawals: allowWithdrawals ?? false,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
      select: {
        id: true,
        name: true,
        scopes: true,
        ipAllowlist: true,
        rateLimitPerMin: true,
        allowWithdrawals: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    publishUserEvent(userId, 'alerts', 'security.api_key_changed', {
      action: 'created',
      keyId: key.id,
      name: key.name,
      scopes: key.scopes,
    }).catch((err) =>
      logger.warn('[Keys] Failed to emit security.api_key_changed', { err })
    )

    return res.status(201).json({
      ...key,
      token: rawToken,
      warning: 'Store this token securely. It will not be shown again.',
    })
  }
)

/** GET /api/v1/keys — list metadata (no secrets). */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const keys = await prisma.userApiKey.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      scopes: true,
      ipAllowlist: true,
      rateLimitPerMin: true,
      allowWithdrawals: true,
      lastUsedAt: true,
      lastUsedIp: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  return res.status(200).json({ keys })
})

/** DELETE /api/v1/keys/:id — revoke a key. */
router.delete(
  '/:id',
  validate({ params: keyIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.userApiKey.findFirst({
      where: { id: req.params.id, userId },
    })
    if (!existing) return sendNotFound(res, 'API key')
    if (existing.revokedAt) {
      return res.status(409).json({ error: 'API key is already revoked' })
    }

    await prisma.userApiKey.update({
      where: { id: req.params.id },
      data: { revokedAt: new Date() },
    })

    publishUserEvent(userId, 'alerts', 'security.api_key_changed', {
      action: 'revoked',
      keyId: existing.id,
      name: existing.name,
    }).catch((err) =>
      logger.warn('[Keys] Failed to emit security.api_key_changed', { err })
    )

    return res.status(200).json({ id: req.params.id, status: 'revoked' })
  }
)

/** POST /api/v1/keys/:id/rotate — issue new secret, invalidate old. */
router.post(
  '/:id/rotate',
  validate({ params: keyIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.userApiKey.findFirst({
      where: { id: req.params.id, userId, revokedAt: null },
    })
    if (!existing) return sendNotFound(res, 'API key')

    const secret = crypto.randomBytes(32).toString('hex')
    const rawToken = generateUserApiKeyToken(existing.id, secret)
    const hash = await hashApiKeyToken(rawToken)
    const tokenPrefix = deriveApiKeyPrefix(rawToken)

    const updated = await prisma.userApiKey.update({
      where: { id: existing.id },
      data: { hash, tokenPrefix },
      select: {
        id: true,
        name: true,
        scopes: true,
        expiresAt: true,
      },
    })

    publishUserEvent(userId, 'alerts', 'security.api_key_changed', {
      action: 'rotated',
      keyId: updated.id,
      name: updated.name,
    }).catch((err) =>
      logger.warn('[Keys] Failed to emit security.api_key_changed', { err })
    )

    return res.status(200).json({
      ...updated,
      token: rawToken,
      warning: 'Store this token securely. It will not be shown again.',
    })
  }
)

/** GET /api/v1/keys/:id/usage — recent usage metadata. */
router.get(
  '/:id/usage',
  validate({ params: keyIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const key = await prisma.userApiKey.findFirst({
      where: { id: req.params.id, userId },
      select: {
        id: true,
        name: true,
        lastUsedAt: true,
        lastUsedIp: true,
        scopes: true,
        createdAt: true,
      },
    })
    if (!key) return sendNotFound(res, 'API key')

    return res.status(200).json({
      keyId: key.id,
      name: key.name,
      lastUsedAt: key.lastUsedAt,
      lastUsedIp: key.lastUsedIp,
      scopes: key.scopes,
      createdAt: key.createdAt,
    })
  }
)

export default router

export { USER_SCOPES, type UserScope }
