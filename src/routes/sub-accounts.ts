import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { SubAccountPermission } from '@prisma/client'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import db from '../db'
import { logger } from '../utils/logger'

const router = Router()

const PERMISSION_VALUES = Object.values(SubAccountPermission)

const createSubAccountSchema = z.object({
  childUserId: z.string().uuid(),
  permissions: z
    .array(z.enum(PERMISSION_VALUES as [string, ...string[]]))
    .min(1)
    .max(4),
})

const updatePermissionsSchema = z.object({
  permissions: z
    .array(z.enum(PERMISSION_VALUES as [string, ...string[]]))
    .min(1)
    .max(4),
})

// ── POST / — create a sub-account relationship ──────────────────────────────
router.post(
  '/',
  requireAuth,
  validate({ body: createSubAccountSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    const { childUserId, permissions } = req.body
    const parentUserId = req.auth!.userId

    // Prevent self-referencing
    if (parentUserId === childUserId) {
      res.status(400).json({ error: 'Cannot create sub-account with yourself' })
      return
    }

    // Verify child user exists
    const childUser = await db.user.findUnique({
      where: { id: childUserId },
      select: { id: true },
    })
    if (!childUser) {
      res.status(404).json({ error: 'Child user not found' })
      return
    }

    // Prevent chained sub-accounts: child must not already be a parent
    const childIsParent = await db.subAccount.findFirst({
      where: { parentUserId: childUserId, status: 'ACTIVE' },
      select: { id: true },
    })
    if (childIsParent) {
      res
        .status(400)
        .json({ error: 'Chained sub-account relationships are not allowed' })
      return
    }

    // Check for existing relationship
    const existing = await db.subAccount.findUnique({
      where: {
        parentUserId_childUserId: { parentUserId, childUserId },
      },
      select: { id: true, status: true },
    })
    if (existing) {
      if (existing.status === 'ACTIVE') {
        res
          .status(409)
          .json({ error: 'Sub-account relationship already exists' })
        return
      }
      // Re-activate a revoked relationship
      const updated = await db.subAccount.update({
        where: { id: existing.id },
        data: {
          permissions: permissions as SubAccountPermission[],
          status: 'ACTIVE',
          revokedAt: null,
        },
      })

      logger.info('[SubAccount] Re-activated sub-account', {
        parentUserId,
        childUserId,
        permissions,
      })

      res.status(201).json({ subAccount: updated })
      return
    }

    const subAccount = await db.subAccount.create({
      data: {
        parentUserId,
        childUserId,
        permissions: permissions as SubAccountPermission[],
      },
    })

    logger.info('[SubAccount] Created sub-account', {
      parentUserId,
      childUserId,
      permissions,
    })

    res.status(201).json({ subAccount })
  }
)

// ── PATCH /:id/permissions — adjust permissions ────────────────────────────
router.patch(
  '/:id/permissions',
  requireAuth,
  validate({ body: updatePermissionsSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    const { id } = req.params
    const { permissions } = req.body
    const parentUserId = req.auth!.userId

    const subAccount = await db.subAccount.findUnique({ where: { id } })
    if (!subAccount) {
      res.status(404).json({ error: 'Sub-account not found' })
      return
    }

    if (subAccount.parentUserId !== parentUserId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const updated = await db.subAccount.update({
      where: { id },
      data: { permissions: permissions as SubAccountPermission[] },
    })

    logger.info('[SubAccount] Updated permissions', {
      parentUserId,
      childUserId: subAccount.childUserId,
      oldPermissions: subAccount.permissions,
      newPermissions: permissions,
    })

    res.json({ subAccount: updated })
  }
)

// ── DELETE /:id — revoke ───────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params
  const parentUserId = req.auth!.userId

  const subAccount = await db.subAccount.findUnique({ where: { id } })
  if (!subAccount) {
    res.status(404).json({ error: 'Sub-account not found' })
    return
  }

  if (subAccount.parentUserId !== parentUserId) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const revoked = await db.subAccount.update({
    where: { id },
    data: {
      status: 'REVOKED',
      revokedAt: new Date(),
    },
  })

  logger.info('[SubAccount] Revoked sub-account', {
    parentUserId,
    childUserId: subAccount.childUserId,
  })

  res.json({ subAccount: revoked })
})

export default router
