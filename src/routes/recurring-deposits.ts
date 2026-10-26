import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { validate } from '../middleware/validate'
import { logger } from '../utils/logger'
import { sendError, sendNotFound } from '../utils/errors'
import {
  createRecurringDepositSchema,
  updateRecurringDepositSchema,
  recurringDepositIdParamSchema,
  previewQuerySchema,
  runLedgerQuerySchema,
} from '../validators/recurring-deposit-validators'
import db from '../db'
import { addCadence } from '../utils/cadence'
import {
  buildPaginationMeta,
  getPaginationParams,
  paginationSchema,
} from '../utils/pagination'
import { generatePreview } from '../deposits/preview'
import type { SmartDcaConfig } from '../deposits/smartDcaPolicy'
import {
  previewGoalCatchUpRuns,
  type CatchUpHorizon,
  type GoalSizingMode,
} from '../goals/contributionSizing'
import { computeGoalProgress } from '../goals/service'

const router = Router()

function computeNextRunAt(
  cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY',
  from: Date
): Date {
  return addCadence(cadence, from)
}

async function buildPlanPreview(plan: any, numRuns: number, now: Date) {
  const sizingMode = ((plan as any).sizingMode ?? 'FIXED') as GoalSizingMode
  const savingsGoalId = ((plan as any).savingsGoalId ?? null) as string | null

  if (
    savingsGoalId &&
    (sizingMode === 'GOAL_CATCH_UP' || sizingMode === 'FIXED')
  ) {
    const sgModel = (db as any).savingsGoal
    const goal =
      sgModel && typeof sgModel.findUnique === 'function'
        ? await sgModel.findUnique({ where: { id: savingsGoalId } })
        : null

    if (goal) {
      let currentAmount = Number(goal.currentAmount ?? goal.startingAmount ?? 0)
      let actualApy: number | null =
        typeof goal.actualApy === 'number' ? goal.actualApy : null

      if (
        actualApy === null &&
        typeof (db as any).position?.findMany === 'function'
      ) {
        try {
          const progress = await computeGoalProgress(goal.id, db)
          currentAmount = progress.currentAmount
          actualApy = progress.actualApy
        } catch {
          // Fallback to goal row's currentAmount / startingAmount
        }
      }

      return previewGoalCatchUpRuns({
        planId: plan.id,
        goalId: goal.id,
        goal: {
          targetAmount: Number(goal.targetAmount),
          targetDate: goal.targetDate,
          startingAmount: Number(goal.startingAmount ?? 0),
          riskCeiling: goal.riskCeiling ?? null,
        },
        currentAmount,
        actualApy,
        cadence: plan.cadence,
        baseAmount: Number(plan.amount),
        sizingMode,
        horizon: ((plan as any).catchUpHorizon ??
          'SPREAD_REMAINING') as CatchUpHorizon,
        bounds: {
          minAmount:
            (plan as any).minAmount !== undefined &&
            (plan as any).minAmount !== null
              ? Number((plan as any).minAmount)
              : null,
          maxAmount:
            (plan as any).maxAmount !== undefined &&
            (plan as any).maxAmount !== null
              ? Number((plan as any).maxAmount)
              : null,
        },
        runs: numRuns,
        now,
      })
    }
  }

  return generatePreview(
    {
      id: plan.id,
      policy: ((plan as any).policy ?? 'FIXED') as SmartDcaConfig['policy'],
      catchUpMode: ((plan as any).catchUpMode ??
        'RETRY') as SmartDcaConfig['catchUpMode'],
      pauseOnDrawdownPct: (plan as any).pauseOnDrawdownPct ?? null,
      doubleOnDrawdown: (plan as any).doubleOnDrawdown ?? false,
      accumulatedRuns: (plan as any).accumulatedRuns ?? 0,
      consecutiveFailures: (plan as any).consecutiveFailures ?? 0,
      allocationMap:
        ((plan as any).allocationMap as Record<string, number>) ?? null,
      cadence: plan.cadence,
      amount: Number(plan.amount),
    },
    null, // regimeInput: null for preview (uses current state)
    null, // drawdownInput: null for preview (uses current state)
    numRuns,
    now
  )
}

// ── Create a recurring deposit plan ────────────────────────────────────────
router.post(
  '/',
  requireAuth,
  requireScope('recurring_deposits:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({
    body: createRecurringDepositSchema,
    errorMessage: 'Validation error',
  }),
  enforceUserAccess,
  async (req: Request, res: Response) => {
    try {
      const {
        userId,
        amount,
        assetSymbol,
        cadence,
        policy,
        catchUpMode,
        pauseOnDrawdownPct,
        doubleOnDrawdown,
        allocationMap,
        savingsGoalId,
        sizingMode,
        minAmount,
        maxAmount,
        catchUpHorizon,
      } = req.body

      if (savingsGoalId) {
        const sgModel = (db as any).savingsGoal
        const goal =
          sgModel && typeof sgModel.findUnique === 'function'
            ? await sgModel.findUnique({ where: { id: savingsGoalId } })
            : null
        if (!goal) {
          return sendNotFound(res, 'Savings goal')
        }
        if (goal.userId !== userId) {
          return sendError(
            res,
            403,
            'Savings goal does not belong to the authenticated user'
          )
        }
        if (goal.status !== 'ACTIVE') {
          return sendError(
            res,
            400,
            'Recurring deposit plan can only link to an ACTIVE savings goal'
          )
        }
      }

      const nextRunAt = computeNextRunAt(cadence, new Date())

      const plan = await db.recurringDepositPlan.create({
        data: {
          userId,
          amount,
          assetSymbol,
          cadence,
          nextRunAt,
          policy: policy ?? 'FIXED',
          catchUpMode: catchUpMode ?? 'RETRY',
          pauseOnDrawdownPct: pauseOnDrawdownPct ?? null,
          doubleOnDrawdown: doubleOnDrawdown ?? false,
          allocationMap: allocationMap ?? undefined,
          ...(savingsGoalId !== undefined ? { savingsGoalId } : {}),
          ...(sizingMode !== undefined ? { sizingMode } : {}),
          ...(minAmount !== undefined ? { minAmount } : {}),
          ...(maxAmount !== undefined ? { maxAmount } : {}),
          ...(catchUpHorizon !== undefined ? { catchUpHorizon } : {}),
        },
      })

      logger.info('[RecurringDeposit] Plan created', {
        planId: plan.id,
        userId,
        cadence,
        amount,
        assetSymbol,
        savingsGoalId: savingsGoalId ?? null,
        sizingMode: sizingMode ?? 'FIXED',
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
  validate({
    params: z.object({ userId: z.string().uuid() }),
    query: paginationSchema.extend({
      status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
      cadence: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY']).optional(),
      assetSymbol: z.string().trim().min(1).max(20).optional(),
      sortBy: z.enum(['createdAt', 'nextRunAt', 'amount']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    }),
  }),
  async (req: Request, res: Response) => {
    const { userId } = req.params
    const { page, limit, skip } = getPaginationParams(req.query)
    const query = req.query as {
      status?: string
      cadence?: string
      assetSymbol?: string
      sortBy: 'createdAt' | 'nextRunAt' | 'amount'
      sortOrder: 'asc' | 'desc'
    }

    const where: any = { userId }
    if (query.status) where.status = query.status
    if (query.cadence) where.cadence = query.cadence
    if (query.assetSymbol) where.assetSymbol = query.assetSymbol

    const plans = await db.recurringDepositPlan.findMany({
      where,
      orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'desc' }],
      skip,
      take: limit,
    })
    const total =
      typeof (db.recurringDepositPlan as any).count === 'function'
        ? await db.recurringDepositPlan.count({ where })
        : plans.length

    return res.json({ ...buildPaginationMeta(page, limit, total), plans })
  }
)

// ── Update a plan (pause/resume/update amount/cadence/goal catch-up) ───────
router.patch(
  '/:id',
  requireAuth,
  requireScope('recurring_deposits:write'),
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

    const {
      amount,
      cadence,
      status,
      policy,
      catchUpMode,
      pauseOnDrawdownPct,
      doubleOnDrawdown,
      allocationMap,
      savingsGoalId,
      sizingMode,
      minAmount,
      maxAmount,
      catchUpHorizon,
    } = req.body

    const effectiveSizingMode =
      sizingMode ?? (plan as any).sizingMode ?? 'FIXED'
    const effectiveGoalId =
      savingsGoalId !== undefined
        ? savingsGoalId
        : ((plan as any).savingsGoalId ?? null)
    const effectiveMin =
      minAmount !== undefined
        ? minAmount
        : (plan as any).minAmount != null
          ? Number((plan as any).minAmount)
          : null
    const effectiveMax =
      maxAmount !== undefined
        ? maxAmount
        : (plan as any).maxAmount != null
          ? Number((plan as any).maxAmount)
          : null

    if (
      effectiveMin !== null &&
      effectiveMax !== null &&
      effectiveMin > effectiveMax
    ) {
      return sendError(
        res,
        400,
        'minAmount must be less than or equal to maxAmount'
      )
    }

    if (effectiveSizingMode === 'GOAL_CATCH_UP') {
      if (!effectiveGoalId) {
        return sendError(
          res,
          400,
          'savingsGoalId is required when sizingMode is GOAL_CATCH_UP'
        )
      }
      if (effectiveMax === null) {
        return sendError(
          res,
          400,
          'maxAmount is required when sizingMode is GOAL_CATCH_UP'
        )
      }
    }

    if (savingsGoalId) {
      const sgModel = (db as any).savingsGoal
      const goal =
        sgModel && typeof sgModel.findUnique === 'function'
          ? await sgModel.findUnique({ where: { id: savingsGoalId } })
          : null
      if (!goal) {
        return sendNotFound(res, 'Savings goal')
      }
      if (goal.userId !== plan.userId) {
        return sendError(
          res,
          403,
          'Savings goal does not belong to the authenticated user'
        )
      }
      if (goal.status !== 'ACTIVE') {
        return sendError(
          res,
          400,
          'Recurring deposit plan can only link to an ACTIVE savings goal'
        )
      }
    }

    const updateData: Record<string, unknown> = {}
    if (amount !== undefined) updateData.amount = amount
    if (cadence !== undefined) {
      updateData.cadence = cadence
      updateData.nextRunAt = computeNextRunAt(cadence, new Date())
    }
    if (status !== undefined) updateData.status = status
    if (policy !== undefined) updateData.policy = policy
    if (catchUpMode !== undefined) updateData.catchUpMode = catchUpMode
    if (pauseOnDrawdownPct !== undefined)
      updateData.pauseOnDrawdownPct = pauseOnDrawdownPct
    if (doubleOnDrawdown !== undefined)
      updateData.doubleOnDrawdown = doubleOnDrawdown
    if (allocationMap !== undefined) updateData.allocationMap = allocationMap
    if (savingsGoalId !== undefined) updateData.savingsGoalId = savingsGoalId
    if (sizingMode !== undefined) updateData.sizingMode = sizingMode
    if (minAmount !== undefined) updateData.minAmount = minAmount
    if (maxAmount !== undefined) updateData.maxAmount = maxAmount
    if (catchUpHorizon !== undefined) updateData.catchUpHorizon = catchUpHorizon

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
router.delete(
  '/:id',
  requireAuth,
  requireScope('recurring_deposits:write'),
  async (req: Request, res: Response) => {
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
  }
)

// ── Preview: GET /preview ─────────────────────────────────────────────
// Registered BEFORE /:id routes so "preview" is never captured as an ID.
router.get(
  '/preview',
  requireAuth,
  validate({ query: previewQuerySchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const numRuns = (req.query.runs as any as number) ?? 12

    // Find the user's most recent ACTIVE plan
    const plan = await db.recurringDepositPlan.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    })

    if (!plan) {
      return sendNotFound(res, 'No active recurring deposit plan')
    }

    try {
      const preview = await buildPlanPreview(plan, numRuns, new Date())
      return res.json(preview)
    } catch (err) {
      logger.error('[RecurringDeposit] Preview failed', {
        planId: plan.id,
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to generate preview')
    }
  }
)

// ── Plan-specific preview: GET /:id/preview (#357) ─────────────────────────
router.get(
  '/:id/preview',
  requireAuth,
  validate({ query: previewQuerySchema }),
  async (req: Request, res: Response) => {
    const { id } = req.params
    const numRuns = (req.query.runs as any as number) ?? 12

    const plan = await db.recurringDepositPlan.findUnique({ where: { id } })
    if (!plan) {
      return sendNotFound(res, 'Recurring deposit plan')
    }

    if (!req.auth || plan.userId !== req.auth.userId) {
      return sendError(res, 401, 'Unauthorized')
    }

    try {
      const preview = await buildPlanPreview(plan, numRuns, new Date())
      return res.json(preview)
    } catch (err) {
      logger.error('[RecurringDeposit] Plan preview failed', {
        planId: plan.id,
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to generate preview')
    }
  }
)

// ── Run ledger: GET /:id/runs ────────────────────────────────────────────
router.get(
  '/:id/runs',
  requireAuth,
  validate({
    params: recurringDepositIdParamSchema,
    query: runLedgerQuerySchema,
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params
    const page = (req.query.page as any as number) ?? 1
    const limit = (req.query.limit as any as number) ?? 20

    const plan = await db.recurringDepositPlan.findUnique({ where: { id } })
    if (!plan) return sendNotFound(res, 'Recurring deposit plan')
    if (!req.auth || plan.userId !== req.auth.userId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const [total, runs] = await Promise.all([
      db.recurringDepositRun.count({ where: { planId: id } }),
      db.recurringDepositRun.findMany({
        where: { planId: id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])

    return res.json({
      planId: id,
      page,
      limit,
      total,
      runs,
    })
  }
)

export default router
