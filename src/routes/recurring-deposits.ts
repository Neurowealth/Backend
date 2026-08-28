import { Router, Request, Response } from 'express'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
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
import { generatePreview } from '../deposits/preview'
import type { SmartDcaConfig } from '../deposits/smartDcaPolicy'

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
      } = req.body
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

    const {
      amount,
      cadence,
      status,
      policy,
      catchUpMode,
      pauseOnDrawdownPct,
      doubleOnDrawdown,
      allocationMap,
    } = req.body

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
      const preview = generatePreview(
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
        new Date()
      )

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
