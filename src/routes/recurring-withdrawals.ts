import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import db from '../db'
import { logger } from '../utils/logger'
import { addCadence } from '../utils/cadence'
import {
  createRecurringWithdrawalSchema,
  updateRecurringWithdrawalSchema,
  recurringWithdrawalIdParamSchema,
  previewRecurringWithdrawalSchema,
} from '../validators/recurring-withdrawal-validators'
import {
  resolveWithdrawalAmount,
  checkDestinationRisk,
  checkGoalGuardrailConflict,
} from '../jobs/recurringWithdrawals'

const router = Router()

// ── POST / — Create recurring withdrawal plan ────────────────────────────────
router.post(
  '/',
  requireAuth,
  validate({
    body: createRecurringWithdrawalSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const {
      userId,
      destinationAddress,
      assetSymbol,
      amountMode,
      amount,
      percentage,
      cadence,
      minAmount,
    } = req.body

    if (req.auth!.userId !== userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const nextRunAt = addCadence(cadence, new Date())

    const plan = await db.recurringWithdrawalPlan.create({
      data: {
        userId,
        destinationAddress,
        assetSymbol,
        amountMode: amountMode ?? 'FIXED',
        amount: amount !== undefined ? amount : null,
        percentage: percentage !== undefined ? percentage : null,
        cadence,
        nextRunAt,
        minAmount: minAmount !== undefined ? minAmount : null,
        status: 'ACTIVE',
      },
    })

    // Log destination risk signal check if new address
    const riskCheck = await checkDestinationRisk(userId, destinationAddress)
    if (riskCheck.isRisk) {
      logger.warn(
        '[RecurringWithdrawal] Created plan with unverified/new destination risk signal',
        { planId: plan.id, userId, destinationAddress, reason: riskCheck.reason }
      )
    }

    logger.info('[RecurringWithdrawal] Created recurring withdrawal plan', {
      planId: plan.id,
      userId,
      destinationAddress,
      amountMode,
      cadence,
    })

    res.status(201).json({ plan })
  }
)

// ── POST /preview or /:id/preview — Preview projected run ───────────────────
router.post(
  '/preview',
  requireAuth,
  validate({
    body: previewRecurringWithdrawalSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const {
      userId,
      destinationAddress,
      assetSymbol,
      amountMode,
      amount,
      percentage,
      cadence,
      minAmount,
    } = req.body

    if (req.auth!.userId !== userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const nextRunAt = addCadence(cadence, new Date())

    // Mock plan object for resolution
    const mockPlan: any = {
      userId,
      assetSymbol,
      amountMode: amountMode ?? 'FIXED',
      amount,
      percentage,
    }

    const { amount: projectedAmount, reason } = await resolveWithdrawalAmount(
      mockPlan
    )
    const riskCheck = destinationAddress
      ? await checkDestinationRisk(userId, destinationAddress)
      : { isRisk: false }
    const goalCheck = await checkGoalGuardrailConflict(
      userId,
      assetSymbol,
      projectedAmount
    )

    res.json({
      preview: {
        projectedAmount,
        nextRunAt,
        cadence,
        amountMode,
        minAmount: minAmount ?? null,
        skipReason: reason ?? null,
        isBelowMinAmount:
          minAmount !== undefined && projectedAmount < minAmount,
        riskFlagged: riskCheck.isRisk,
        riskReason: riskCheck.reason ?? null,
        guardrailConflict: goalCheck.conflict,
        guardrailReason: goalCheck.reason ?? null,
      },
    })
  }
)

router.post(
  '/:id/preview',
  requireAuth,
  validate({
    params: recurringWithdrawalIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params

    const plan = await db.recurringWithdrawalPlan.findUnique({ where: { id } })
    if (!plan) {
      res.status(404).json({ error: 'Recurring withdrawal plan not found' })
      return
    }

    if (plan.userId !== req.auth!.userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const { amount: projectedAmount, reason } = await resolveWithdrawalAmount(
      plan
    )
    const riskCheck = await checkDestinationRisk(
      plan.userId,
      plan.destinationAddress
    )
    const goalCheck = await checkGoalGuardrailConflict(
      plan.userId,
      plan.assetSymbol,
      projectedAmount
    )

    res.json({
      preview: {
        projectedAmount,
        nextRunAt: plan.nextRunAt,
        cadence: plan.cadence,
        amountMode: plan.amountMode,
        minAmount: plan.minAmount ? Number(plan.minAmount) : null,
        skipReason: reason ?? null,
        isBelowMinAmount:
          plan.minAmount != null && projectedAmount < Number(plan.minAmount),
        riskFlagged: riskCheck.isRisk,
        riskReason: riskCheck.reason ?? null,
        guardrailConflict: goalCheck.conflict,
        guardrailReason: goalCheck.reason ?? null,
      },
    })
  }
)

// ── GET / — List user's recurring withdrawal plans ───────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) ?? req.auth!.userId

  if (userId !== req.auth!.userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const plans = await db.recurringWithdrawalPlan.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })

  res.json({ plans })
})

// ── GET /:id — Get single plan ───────────────────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  validate({
    params: recurringWithdrawalIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params

    const plan = await db.recurringWithdrawalPlan.findUnique({ where: { id } })
    if (!plan) {
      res.status(404).json({ error: 'Recurring withdrawal plan not found' })
      return
    }

    if (plan.userId !== req.auth!.userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    res.json({ plan })
  }
)

// ── PATCH /:id — Update plan ─────────────────────────────────────────────────
router.patch(
  '/:id',
  requireAuth,
  validate({
    params: recurringWithdrawalIdParamSchema,
    body: updateRecurringWithdrawalSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params
    const updates = req.body

    const existing = await db.recurringWithdrawalPlan.findUnique({
      where: { id },
    })
    if (!existing) {
      res.status(404).json({ error: 'Recurring withdrawal plan not found' })
      return
    }

    if (existing.userId !== req.auth!.userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    // Treat destinationAddress change as NEW_DESTINATION risk signal
    if (
      updates.destinationAddress &&
      updates.destinationAddress !== existing.destinationAddress
    ) {
      logger.warn(
        '[RecurringWithdrawal] Destination address modified; treating as new destination risk signal',
        {
          planId: id,
          oldAddress: existing.destinationAddress,
          newAddress: updates.destinationAddress,
        }
      )
    }

    const updated = await db.recurringWithdrawalPlan.update({
      where: { id },
      data: updates,
    })

    res.json({ plan: updated })
  }
)

// ── DELETE /:id — Cancel plan ────────────────────────────────────────────────
router.delete(
  '/:id',
  requireAuth,
  validate({
    params: recurringWithdrawalIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params

    const existing = await db.recurringWithdrawalPlan.findUnique({
      where: { id },
    })
    if (!existing) {
      res.status(404).json({ error: 'Recurring withdrawal plan not found' })
      return
    }

    if (existing.userId !== req.auth!.userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const cancelled = await db.recurringWithdrawalPlan.update({
      where: { id },
      data: { status: 'CANCELLED' },
    })

    logger.info('[RecurringWithdrawal] Cancelled recurring withdrawal plan', {
      planId: id,
      userId: existing.userId,
    })

    res.json({ plan: cancelled })
  }
)

export default router
