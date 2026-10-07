import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { SubAccountPermission } from '@prisma/client'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import db from '../db'
import { logger } from '../utils/logger'
import {
  bulkSubAccountsSchema,
  BulkSubAccountOp,
} from '../validators/sub-account-bulk-validators'

const router = Router()

const PERMISSION_VALUES = Object.values(SubAccountPermission)
const MAX_BULK_BATCH_SIZE = 100

const createSubAccountSchema = z.object({
  childUserId: z.string().uuid(),
  permissions: z
    .array(z.enum(PERMISSION_VALUES as [string, ...string[]]))
    .min(1)
    .max(4),
  dailyLimit: z.number().positive().optional(),
  transactionLimit: z.number().positive().optional(),
})

const updatePermissionsSchema = z.object({
  permissions: z
    .array(z.enum(PERMISSION_VALUES as [string, ...string[]]))
    .min(1)
    .max(4),
})

// ── GET /summary — Aggregate summary view for sub-accounts (#554) ────────────
router.get('/summary', requireAuth, async (req: Request, res: Response) => {
  const parentUserId = req.auth!.userId

  const subAccounts = await db.subAccount.findMany({
    where: { parentUserId },
  })

  const activeChildren = subAccounts.filter((s) => s.status === 'ACTIVE')
  const revokedChildren = subAccounts.filter((s) => s.status === 'REVOKED')

  const permissionDistribution: Record<string, number> = {}
  for (const perm of PERMISSION_VALUES) {
    permissionDistribution[perm] = 0
  }

  let totalDailyLimitExposure = 0
  let totalTransactionLimitExposure = 0

  for (const sub of activeChildren) {
    for (const perm of sub.permissions) {
      permissionDistribution[perm] = (permissionDistribution[perm] || 0) + 1
    }

    if (sub.dailyLimit) {
      totalDailyLimitExposure += Number(sub.dailyLimit)
    }
    if (sub.transactionLimit) {
      totalTransactionLimitExposure += Number(sub.transactionLimit)
    }
  }

  const childUserIds = activeChildren.map((s) => s.childUserId)
  const recentActivityCount =
    childUserIds.length > 0
      ? await db.transaction.count({
          where: {
            userId: { in: childUserIds },
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        })
      : 0

  res.json({
    summary: {
      totalChildren: subAccounts.length,
      activeChildren: activeChildren.length,
      revokedChildren: revokedChildren.length,
      permissionDistribution,
      totalDailyLimitExposure,
      totalTransactionLimitExposure,
      recentActivityCount,
    },
  })
})

// ── POST /bulk — Bulk/batch sub-account operations (#554) ────────────────────
router.post(
  '/bulk',
  requireAuth,
  validate({ body: bulkSubAccountsSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    const parentUserId = req.auth!.userId
    const { operations, atomic } = req.body

    // Bounded batch size check (fail-fast upfront)
    if (operations.length > MAX_BULK_BATCH_SIZE) {
      res.status(400).json({
        error: `Batch size exceeds maximum limit of ${MAX_BULK_BATCH_SIZE} operations`,
      })
      return
    }

    const processOp = async (op: BulkSubAccountOp, txDb: any) => {
      if (op.action === 'create') {
        if (!op.childUserId) {
          throw new Error('childUserId is required for create action')
        }
        if (parentUserId === op.childUserId) {
          throw new Error('Cannot create sub-account with yourself')
        }

        const childUser = await txDb.user.findUnique({
          where: { id: op.childUserId },
          select: { id: true },
        })
        if (!childUser) {
          throw new Error('Child user not found')
        }

        const childIsParent = await txDb.subAccount.findFirst({
          where: { parentUserId: op.childUserId, status: 'ACTIVE' },
          select: { id: true },
        })
        if (childIsParent) {
          throw new Error('Chained sub-account relationships are not allowed')
        }

        const perms =
          op.payload?.permissions ?? ([SubAccountPermission.VIEW] as any)

        const existing = await txDb.subAccount.findUnique({
          where: {
            parentUserId_childUserId: {
              parentUserId,
              childUserId: op.childUserId,
            },
          },
        })

        if (existing) {
          const updated = await txDb.subAccount.update({
            where: { id: existing.id },
            data: {
              permissions: perms,
              status: 'ACTIVE',
              revokedAt: null,
              ...(op.payload?.dailyLimit !== undefined
                ? { dailyLimit: op.payload.dailyLimit }
                : {}),
              ...(op.payload?.transactionLimit !== undefined
                ? { transactionLimit: op.payload.transactionLimit }
                : {}),
            },
          })

          logger.info(
            '[SubAccountBulk] Re-activated sub-account in batch op',
            { parentUserId, childUserId: op.childUserId, action: op.action }
          )
          return updated
        }

        const created = await txDb.subAccount.create({
          data: {
            parentUserId,
            childUserId: op.childUserId,
            permissions: perms,
            ...(op.payload?.dailyLimit !== undefined
              ? { dailyLimit: op.payload.dailyLimit }
              : {}),
            ...(op.payload?.transactionLimit !== undefined
              ? { transactionLimit: op.payload.transactionLimit }
              : {}),
          },
        })

        logger.info('[SubAccountBulk] Created sub-account in batch op', {
          parentUserId,
          childUserId: op.childUserId,
          action: op.action,
        })
        return created
      }

      // For update, setPermission, setLimit, or revoke
      let subAccount: any = null
      if (op.subAccountId) {
        subAccount = await txDb.subAccount.findUnique({
          where: { id: op.subAccountId },
        })
      } else if (op.childUserId) {
        subAccount = await txDb.subAccount.findUnique({
          where: {
            parentUserId_childUserId: {
              parentUserId,
              childUserId: op.childUserId,
            },
          },
        })
      }

      if (!subAccount || subAccount.parentUserId !== parentUserId) {
        throw new Error('Sub-account not found or forbidden')
      }

      if (op.action === 'revoke') {
        const revoked = await txDb.subAccount.update({
          where: { id: subAccount.id },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
          },
        })

        logger.info('[SubAccountBulk] Revoked sub-account in batch op', {
          parentUserId,
          subAccountId: subAccount.id,
        })
        return revoked
      }

      const updateData: any = {}
      if (op.action === 'setPermission' || op.action === 'update') {
        if (op.payload?.permissions) {
          updateData.permissions = op.payload.permissions
        }
      }
      if (op.action === 'setLimit' || op.action === 'update') {
        if (op.payload?.dailyLimit !== undefined) {
          updateData.dailyLimit = op.payload.dailyLimit
        }
        if (op.payload?.transactionLimit !== undefined) {
          updateData.transactionLimit = op.payload.transactionLimit
        }
      }

      const updated = await txDb.subAccount.update({
        where: { id: subAccount.id },
        data: updateData,
      })

      logger.info('[SubAccountBulk] Updated sub-account in batch op', {
        parentUserId,
        subAccountId: subAccount.id,
        action: op.action,
      })
      return updated
    }

    if (atomic) {
      try {
        const results = await db.$transaction(async (tx) => {
          const resArr = []
          for (let i = 0; i < operations.length; i++) {
            const data = await processOp(operations[i], tx)
            resArr.push({ index: i, success: true, data })
          }
          return resArr
        })

        res.json({ atomic: true, results })
      } catch (err: any) {
        logger.warn(
          '[SubAccountBulk] Atomic batch transaction rolled back',
          { parentUserId, error: err.message }
        )
        res.status(400).json({
          atomic: true,
          error: 'Atomic batch failed; transaction rolled back',
          message: err.message,
        })
      }
      return
    }

    // Default non-atomic mode: process operations independently
    const results = []
    for (let i = 0; i < operations.length; i++) {
      try {
        const data = await processOp(operations[i], db)
        results.push({ index: i, success: true, data })
      } catch (err: any) {
        results.push({
          index: i,
          success: false,
          error: err.message ?? 'Operation failed',
        })
      }
    }

    res.json({ atomic: false, results })
  }
)

// ── POST / — create a sub-account relationship ──────────────────────────────
router.post(
  '/',
  requireAuth,
  validate({ body: createSubAccountSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    const { childUserId, permissions, dailyLimit, transactionLimit } = req.body
    const parentUserId = req.auth!.userId

    if (parentUserId === childUserId) {
      res.status(400).json({ error: 'Cannot create sub-account with yourself' })
      return
    }

    const childUser = await db.user.findUnique({
      where: { id: childUserId },
      select: { id: true },
    })
    if (!childUser) {
      res.status(404).json({ error: 'Child user not found' })
      return
    }

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
        ...(dailyLimit !== undefined ? { dailyLimit } : {}),
        ...(transactionLimit !== undefined ? { transactionLimit } : {}),
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
