import { Router, Request, Response } from 'express'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { validate } from '../middleware/validate'
import { logger } from '../utils/logger'
import { sendError, sendNotFound } from '../utils/errors'
import { publishUserEvent } from '../events/publisher'
import {
  createRecurringWithdrawalSchema,
  updateRecurringWithdrawalSchema,
  recurringWithdrawalIdParamSchema,
  recurringWithdrawalUserParamSchema,
} from '../validators/recurring-withdrawal-validators'
import db from '../db'
import { addCadence } from '../utils/cadence'
import { isKnownDestinationAddress } from '../jobs/recurringWithdrawals'

const router = Router()

/**
 * Compute the next run timestamp based on cadence and reference date.
 *
 * @param cadence The withdrawal interval.
 * @param from The baseline date.
 * @returns The next scheduled execution timestamp.
 */
function computeNextRunAt(
  cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY',
  from: Date
): Date {
  return addCadence(cadence, from)
}

/**
 * Resolve total balance and accrued yield across active positions for an asset.
 *
 * @param userId Target user ID.
 * @param assetSymbol Asset ticker symbol.
 * @returns Aggregated balance and accrued yield.
 */
async function resolveAssetHoldings(
  userId: string,
  assetSymbol: string
): Promise<{ totalBalance: number; totalYield: number }> {
  const positions = await db.position.findMany({
    where: { userId, assetSymbol, status: 'ACTIVE' },
  })
  const totalBalance = positions.reduce(
    (sum, p) => sum + Number(p.currentValue),
    0
  )
  const totalYield = positions.reduce(
    (sum, p) => sum + Number(p.yieldEarned),
    0
  )
  return { totalBalance, totalYield }
}

/**
 * POST /api/v1/recurring-withdrawals
 * Creates a recurring withdrawal plan.
 */
router.post(
  '/',
  requireAuth,
  requireScope('recurring_withdrawals:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({
    body: createRecurringWithdrawalSchema,
    errorMessage: 'Validation error',
  }),
  enforceUserAccess,
  async (req: Request, res: Response) => {
    try {
      const {
        userId,
        destinationAddress,
        assetSymbol,
        amountMode = 'FIXED',
        amount,
        amountValue,
        minAmount,
        cadence,
      } = req.body

      const resolvedAmount = amount ?? amountValue ?? null
      const nextRunAt = computeNextRunAt(cadence, new Date())

      const isKnown = await isKnownDestinationAddress(
        userId,
        destinationAddress
      )
      if (!isKnown) {
        logger.warn(
          '[RecurringWithdrawal] Plan created with new destination address',
          {
            userId,
            destinationAddress,
          }
        )
      }

      const plan = await db.recurringWithdrawalPlan.create({
        data: {
          userId,
          destinationAddress,
          assetSymbol,
          amountMode,
          amount: resolvedAmount,
          amountValue: resolvedAmount,
          minAmount: minAmount ?? null,
          cadence,
          nextRunAt,
          status: 'ACTIVE',
        },
      })

      logger.info('[RecurringWithdrawal] Plan created', {
        planId: plan.id,
        userId,
        cadence,
        amountMode,
        amount: resolvedAmount,
        assetSymbol,
        destinationAddress,
      })

      return res.status(201).json({ plan })
    } catch (err) {
      logger.error('[RecurringWithdrawal] Creation failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to create recurring withdrawal plan')
    }
  }
)

/**
 * GET /api/v1/recurring-withdrawals/by-user/:userId
 * Lists all recurring withdrawal plans for a user.
 */
router.get(
  '/by-user/:userId',
  requireAuth,
  validate({
    params: recurringWithdrawalUserParamSchema,
    errorMessage: 'Validation error',
  }),
  enforceUserAccess,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params

      const plans = await db.recurringWithdrawalPlan.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      })

      return res.json({ plans })
    } catch (err) {
      logger.error('[RecurringWithdrawal] Listing failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to list recurring withdrawal plans')
    }
  }
)

/**
 * Preview logic calculator.
 */
async function generatePreview(plan: any) {
  const { totalBalance, totalYield } = await resolveAssetHoldings(
    plan.userId,
    plan.assetSymbol
  )

  let rawAmount = 0
  if (plan.amountMode === 'FIXED') {
    rawAmount = Number(plan.amountValue ?? plan.amount ?? 0)
  } else if (plan.amountMode === 'PERCENT_OF_BALANCE') {
    const pct = Number(plan.amountValue ?? plan.amount ?? 0)
    const ratio = pct > 1 ? pct / 100 : pct
    rawAmount = Math.max(0, totalBalance * ratio)
  } else if (plan.amountMode === 'YIELD_ONLY') {
    rawAmount = Math.max(0, totalYield)
  }

  let projectedAmount = rawAmount
  let isPartial = false
  let willSkip = false
  let skipReason: string | null = null

  const minThreshold = plan.minAmount != null ? Number(plan.minAmount) : 0

  if (plan.amountMode === 'FIXED' && totalBalance < rawAmount) {
    if (minThreshold > 0 && totalBalance >= minThreshold) {
      projectedAmount = totalBalance
      isPartial = true
    } else {
      projectedAmount = 0
      willSkip = true
      skipReason = 'INSUFFICIENT_FUNDS'
    }
  } else if (minThreshold > 0 && rawAmount < minThreshold) {
    projectedAmount = rawAmount
    willSkip = true
    skipReason = 'BELOW_MINIMUM'
  } else if (rawAmount <= 0) {
    projectedAmount = 0
    willSkip = true
    skipReason = 'ZERO_AMOUNT'
  }

  const isKnown = await isKnownDestinationAddress(
    plan.userId,
    plan.destinationAddress
  )
  const isNewDestination = !isKnown

  let goalConflict = false
  const activeGoal = await db.savingsGoal.findFirst({
    where: { userId: plan.userId, status: 'ACTIVE' },
  })
  if (activeGoal && projectedAmount > 0) {
    let currentGoalAmount = totalBalance
    if (activeGoal.positionId) {
      const pos = await db.position.findUnique({
        where: { id: activeGoal.positionId },
      })
      if (pos && pos.userId === plan.userId) {
        currentGoalAmount = Number(pos.currentValue)
      }
    }
    const targetAmount = Number(activeGoal.targetAmount)
    if (currentGoalAmount - projectedAmount < targetAmount) {
      goalConflict = true
    }
  }

  let status: string = 'READY'
  if (willSkip) {
    status = 'WOULD_SKIP'
  } else if (isNewDestination) {
    status = 'WOULD_HOLD_NEW_DESTINATION'
  } else if (goalConflict) {
    status = 'WOULD_HOLD_GOAL_CONFLICT'
  }

  return {
    planId: plan.id,
    userId: plan.userId,
    destinationAddress: plan.destinationAddress,
    assetSymbol: plan.assetSymbol,
    cadence: plan.cadence,
    amountMode: plan.amountMode,
    configuredAmount: Number(plan.amountValue ?? plan.amount ?? 0),
    minAmount: minThreshold > 0 ? minThreshold : null,
    totalBalance,
    totalYield,
    projectedAmount,
    isPartial,
    willSkip,
    skipReason,
    isNewDestination,
    goalConflict,
    nextRunAt: plan.nextRunAt,
    status,
  }
}

/**
 * GET /api/v1/recurring-withdrawals/:id/preview
 * Evaluates projected next run outcome without executing on-chain.
 */
router.get(
  '/:id/preview',
  requireAuth,
  validate({
    params: recurringWithdrawalIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params

      const plan = await db.recurringWithdrawalPlan.findUnique({
        where: { id },
      })
      if (!plan) {
        return sendNotFound(res, 'Recurring withdrawal plan')
      }

      if (!req.auth || plan.userId !== req.auth.userId) {
        return sendError(res, 401, 'Unauthorized')
      }

      const preview = await generatePreview(plan)
      return res.json({ preview })
    } catch (err) {
      logger.error('[RecurringWithdrawal] Preview failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to preview recurring withdrawal')
    }
  }
)

/**
 * POST /api/v1/recurring-withdrawals/:id/preview
 * Evaluates projected next run outcome without executing on-chain (POST alias).
 */
router.post(
  '/:id/preview',
  requireAuth,
  validate({
    params: recurringWithdrawalIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params

      const plan = await db.recurringWithdrawalPlan.findUnique({
        where: { id },
      })
      if (!plan) {
        return sendNotFound(res, 'Recurring withdrawal plan')
      }

      if (!req.auth || plan.userId !== req.auth.userId) {
        return sendError(res, 401, 'Unauthorized')
      }

      const preview = await generatePreview(plan)
      return res.json({ preview })
    } catch (err) {
      logger.error('[RecurringWithdrawal] Preview failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to preview recurring withdrawal')
    }
  }
)

/**
 * GET /api/v1/recurring-withdrawals/:id
 * Fetches a single recurring withdrawal plan.
 */
router.get(
  '/:id',
  requireAuth,
  validate({
    params: recurringWithdrawalIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params

      const plan = await db.recurringWithdrawalPlan.findUnique({
        where: { id },
      })
      if (!plan) {
        return sendNotFound(res, 'Recurring withdrawal plan')
      }

      if (!req.auth || plan.userId !== req.auth.userId) {
        return sendError(res, 401, 'Unauthorized')
      }

      return res.json({ plan })
    } catch (err) {
      logger.error('[RecurringWithdrawal] Lookup failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to fetch recurring withdrawal plan')
    }
  }
)

/**
 * PATCH /api/v1/recurring-withdrawals/:id
 * Updates an existing plan. Destination address changes are flagged as risk signals.
 */
router.patch(
  '/:id',
  requireAuth,
  requireScope('recurring_withdrawals:write'),
  validate({
    params: recurringWithdrawalIdParamSchema,
    body: updateRecurringWithdrawalSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params

      const plan = await db.recurringWithdrawalPlan.findUnique({
        where: { id },
      })
      if (!plan) {
        return sendNotFound(res, 'Recurring withdrawal plan')
      }

      if (!req.auth || plan.userId !== req.auth.userId) {
        return sendError(res, 401, 'Unauthorized')
      }

      const {
        destinationAddress,
        amountMode,
        amount,
        amountValue,
        minAmount,
        cadence,
        status,
      } = req.body

      const updateData: Record<string, unknown> = {}

      if (
        destinationAddress !== undefined &&
        destinationAddress !== plan.destinationAddress
      ) {
        updateData.destinationAddress = destinationAddress
        updateData.lastRunStatus = 'held_new_destination'
        logger.warn(
          '[RecurringWithdrawal] Destination address changed - flagged as risk signal',
          {
            planId: id,
            userId: plan.userId,
            previousDestination: plan.destinationAddress,
            updatedDestination: destinationAddress,
          }
        )
        publishUserEvent(plan.userId, 'alerts', 'recurring_withdrawal.held', {
          planId: id,
          reason:
            'Destination address updated — requires review before automated execution.',
          previousDestination: plan.destinationAddress,
          updatedDestination: destinationAddress,
        }).catch(() => {})
      }

      if (amountMode !== undefined) updateData.amountMode = amountMode
      if (amount !== undefined || amountValue !== undefined) {
        const val = amount ?? amountValue
        updateData.amount = val
        updateData.amountValue = val
      }
      if (minAmount !== undefined) updateData.minAmount = minAmount
      if (cadence !== undefined) {
        updateData.cadence = cadence
        updateData.nextRunAt = computeNextRunAt(cadence, new Date())
      }
      if (status !== undefined) updateData.status = status

      const updated = await db.recurringWithdrawalPlan.update({
        where: { id },
        data: updateData,
      })

      logger.info('[RecurringWithdrawal] Plan updated', {
        planId: id,
        updates: Object.keys(updateData),
      })

      return res.json({ plan: updated })
    } catch (err) {
      logger.error('[RecurringWithdrawal] Update failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to update recurring withdrawal plan')
    }
  }
)

/**
 * DELETE /api/v1/recurring-withdrawals/:id
 * Cancels a recurring withdrawal plan.
 */
router.delete(
  '/:id',
  requireAuth,
  requireScope('recurring_withdrawals:write'),
  validate({
    params: recurringWithdrawalIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params

      const plan = await db.recurringWithdrawalPlan.findUnique({
        where: { id },
      })
      if (!plan) {
        return sendNotFound(res, 'Recurring withdrawal plan')
      }

      if (!req.auth || plan.userId !== req.auth.userId) {
        return sendError(res, 401, 'Unauthorized')
      }

      const updated = await db.recurringWithdrawalPlan.update({
        where: { id },
        data: { status: 'CANCELLED' },
      })

      logger.info('[RecurringWithdrawal] Plan cancelled', { planId: id })

      return res.json({ plan: updated })
    } catch (err) {
      logger.error('[RecurringWithdrawal] Cancellation failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to cancel recurring withdrawal plan')
    }
  }
)

export default router
