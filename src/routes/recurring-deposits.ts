import { Router, Request, Response } from 'express'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { idempotent } from '../middleware/idempotency'
import { validate } from '../middleware/validate'
import { logger } from '../utils/logger'
import { sendError, sendNotFound } from '../utils/errors'
import {
  createRecurringDepositSchema,
  updateRecurringDepositSchema,
} from '../validators/recurring-deposit-validators'
import db from '../db'
import { addCadence } from '../utils/cadence'

const router = Router()

function computeNextRunAt(
  cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY',
  from: Date
): Date {
  return addCadence(cadence, from)
}

// ── Create a recurring deposit plan ────────────────────────────────────────
router.post(
  '/',
  requireAuth,
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({
    body: createRecurringDepositSchema,
    errorMessage: 'Validation error',
  }),
  enforceUserAccess,
  async (req: Request, res: Response) => {
    try {
      const { userId, amount, assetSymbol, cadence } = req.body
      const nextRunAt = computeNextRunAt(cadence, new Date())

      const plan = await db.recurringDepositPlan.create({
        data: {
          userId,
          amount,
          assetSymbol,
          cadence,
          nextRunAt,
        },
      })

      logger.info('[RecurringDeposit] Plan created', {
        planId: plan.id,
        userId,
        cadence,
        amount,
        assetSymbol,
      })

      return res.status(201).json({ plan })
    } catch (err) {
      logger.error('[RecurringDeposit] Creation failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to create recurring deposit plan')
    }
  }
)

// ── List plans for a user ──────────────────────────────────────────────────
router.get(
  '/by-user/:userId',
  requireAuth,
  enforceUserAccess,
  async (req: Request, res: Response) => {
    const { userId } = req.params

    const plans = await db.recurringDepositPlan.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })

    return res.json({ plans })
  }
)

// ── Update a plan (pause/resume/update amount/cadence) ────────────────────
router.patch(
  '/:id',
  requireAuth,
  validate({
    body: updateRecurringDepositSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params

    const plan = await db.recurringDepositPlan.findUnique({ where: { id } })
    if (!plan) {
      return sendNotFound(res, 'Recurring deposit plan')
    }

    if (!req.auth || plan.userId !== req.auth.userId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const { amount, cadence, status } = req.body

    const updateData: Record<string, unknown> = {}
    if (amount !== undefined) updateData.amount = amount
    if (cadence !== undefined) {
      updateData.cadence = cadence
      updateData.nextRunAt = computeNextRunAt(cadence, new Date())
    }
    if (status !== undefined) updateData.status = status

    const updated = await db.recurringDepositPlan.update({
      where: { id },
      data: updateData,
    })

    logger.info('[RecurringDeposit] Plan updated', {
      planId: id,
      updates: Object.keys(updateData),
    })

    return res.json({ plan: updated })
  }
)

// ── Cancel a plan ──────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params

  const plan = await db.recurringDepositPlan.findUnique({ where: { id } })
  if (!plan) {
    return sendNotFound(res, 'Recurring deposit plan')
  }

  if (!req.auth || plan.userId !== req.auth.userId) {
    return sendError(res, 401, 'Unauthorized')
  }

  const updated = await db.recurringDepositPlan.update({
    where: { id },
    data: { status: 'CANCELLED' },
  })

  logger.info('[RecurringDeposit] Plan cancelled', { planId: id })

  return res.json({ plan: updated })
})

export default router
