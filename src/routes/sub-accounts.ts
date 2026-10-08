import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express'
import { SubAccount, SubAccountPermission } from '@prisma/client'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import db from '../db'
import { logger } from '../utils/logger'
import {
  bulkSubAccountsSchema,
  bulkSubAccountOpSchema,
  MAX_BULK_BATCH_SIZE,
  createSubAccountSchema,
  updatePermissionsSchema,
  updateLimitsSchema,
} from '../validators/sub-account-bulk-validators'
import {
  createSubAccount,
  updateSubAccount,
  applySubAccountOperation,
  SubAccountManagementError,
} from '../services/sub-account-management.service'

const router = Router()
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch((error: unknown) => {
      if (error instanceof SubAccountManagementError)
        res.status(error.status).json({ error: error.message })
      else next(error)
    })
  }
const audit = (
  parentUserId: string,
  action: string,
  subAccount: SubAccount
) => {
  logger.info('[SubAccount] Management operation committed', {
    parentUserId,
    childUserId: subAccount.childUserId,
    subAccountId: subAccount.id,
    action,
    permissions: subAccount.permissions,
    dailyLimit: subAccount.dailyLimit?.toString(),
  })
}

router.get(
  '/summary',
  requireAuth,
  handle(async (req, res) => {
    const subAccounts = await db.subAccount.findMany({
      where: { parentUserId: req.auth!.userId },
    })
    const active = subAccounts.filter((s) => s.status === 'ACTIVE')
    const permissionDistribution: Record<string, number> = Object.fromEntries(
      Object.values(SubAccountPermission).map((p) => [p, 0])
    )
    let totalDailyLimitExposure = 0
    let totalTransactionLimitExposure = 0
    for (const sub of active) {
      for (const permission of new Set(sub.permissions))
        permissionDistribution[permission]++
      totalDailyLimitExposure += Number(sub.dailyLimit || 0)
      totalTransactionLimitExposure += Number(sub.transactionLimit || 0)
    }
    const recentActivityCount = active.length
      ? await db.transaction.count({
          where: {
            userId: { in: active.map((s) => s.childUserId) },
            createdAt: { gte: new Date(Date.now() - 30 * 86400000) },
          },
        })
      : 0
    res.json({
      summary: {
        totalChildren: subAccounts.length,
        activeChildren: active.length,
        revokedChildren: subAccounts.length - active.length,
        permissionDistribution,
        totalDailyLimitExposure,
        totalTransactionLimitExposure,
        unlimitedDailyLimitChildren: active.filter((s) => s.dailyLimit === null)
          .length,
        recentActivityCount,
      },
    })
  })
)

router.post(
  '/bulk',
  requireAuth,
  validate({ body: bulkSubAccountsSchema }),
  handle(async (req, res) => {
    const { operations, atomic } = bulkSubAccountsSchema.parse(req.body)
    const parentUserId = req.auth!.userId
    if (operations.length > MAX_BULK_BATCH_SIZE) {
      res
        .status(400)
        .json({
          error: `Batch size exceeds maximum limit of ${MAX_BULK_BATCH_SIZE} operations`,
        })
      return
    }
    const errorText = (err: unknown) =>
      err instanceof Error ? err.message : 'Operation failed'
    if (atomic) {
      let failedIndex = 0
      try {
        const results = await db.$transaction(async (tx) => {
          const rows = []
          for (let index = 0; index < operations.length; index++) {
            failedIndex = index
            const parsed = bulkSubAccountOpSchema.safeParse(operations[index])
            if (!parsed.success)
              throw new SubAccountManagementError(
                parsed.error.issues.map((i) => i.message).join('; '),
                400
              )
            rows.push({
              index,
              success: true,
              action: parsed.data.action,
              data: await applySubAccountOperation(
                parentUserId,
                parsed.data,
                tx
              ),
            })
          }
          return rows
        })
        for (const result of results)
          audit(parentUserId, result.action, result.data)
        res.json({ atomic: true, results })
      } catch (err) {
        res
          .status(400)
          .json({
            atomic: true,
            rolledBack: true,
            failedIndex,
            error: 'Atomic batch failed; transaction rolled back',
            message: errorText(err),
            results: operations.map((_, index) => ({
              index,
              success: false,
              ...(index === failedIndex
                ? { error: errorText(err) }
                : index < failedIndex
                  ? { rolledBack: true }
                  : { skipped: true }),
            })),
          })
      }
      return
    }
    const results = []
    for (let index = 0; index < operations.length; index++) {
      const parsed = bulkSubAccountOpSchema.safeParse(operations[index])
      if (!parsed.success) {
        results.push({
          index,
          success: false,
          status: 400,
          error: parsed.error.issues.map((i) => i.message).join('; '),
        })
        continue
      }
      try {
        const data = await applySubAccountOperation(parentUserId, parsed.data)
        audit(parentUserId, parsed.data.action, data)
        results.push({ index, success: true, data })
      } catch (err) {
        results.push({
          index,
          success: false,
          status: err instanceof SubAccountManagementError ? err.status : 500,
          error: errorText(err),
        })
      }
    }
    res.json({ atomic: false, results })
  })
)

router.post(
  '/',
  requireAuth,
  validate({ body: createSubAccountSchema, errorMessage: 'Validation error' }),
  handle(async (req, res) => {
    const subAccount = await createSubAccount(req.auth!.userId, req.body)
    audit(req.auth!.userId, 'create', subAccount)
    res.status(201).json({ subAccount })
  })
)
router.patch(
  '/:id/permissions',
  requireAuth,
  validate({ body: updatePermissionsSchema, errorMessage: 'Validation error' }),
  handle(async (req, res) => {
    const subAccount = await updateSubAccount(
      req.auth!.userId,
      { subAccountId: req.params.id },
      { permissions: req.body.permissions }
    )
    audit(req.auth!.userId, 'setPermission', subAccount)
    res.json({ subAccount })
  })
)
router.patch(
  '/:id/limits',
  requireAuth,
  validate({ body: updateLimitsSchema, errorMessage: 'Validation error' }),
  handle(async (req, res) => {
    const subAccount = await updateSubAccount(
      req.auth!.userId,
      { subAccountId: req.params.id },
      req.body
    )
    audit(req.auth!.userId, 'setLimit', subAccount)
    res.json({ subAccount })
  })
)
router.delete(
  '/:id',
  requireAuth,
  handle(async (req, res) => {
    const subAccount = await updateSubAccount(
      req.auth!.userId,
      { subAccountId: req.params.id },
      { status: 'REVOKED', revokedAt: new Date() }
    )
    audit(req.auth!.userId, 'revoke', subAccount)
    res.json({ subAccount })
  })
)

export default router
