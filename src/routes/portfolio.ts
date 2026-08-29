import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import {
  mapAllocationSuggestionToResponse,
  mapPositionToResponse,
} from '../utils/api-formatters'
import { sendNotFound } from '../utils/errors'
import { optimizerRateLimiter } from '../middleware/rateLimiter'
import { ConcurrencyLimiter, isAcquireFailure } from '../utils/concurrency'
import { config } from '../config/env'
import { logger } from '../utils/logger'
import {
  suggestAllocation,
  SuggestionUserNotFoundError,
} from '../analytics/service'
import {
  listSuggestionsSchema,
  suggestAllocationSchema,
} from '../validators/allocation-validators'
import {
  formatPortfolioEarningsReply,
  formatPortfolioHistoryReply,
  formatPortfolioReply,
} from '../whatsapp/formatters'
import { userIdParamSchema } from '../validators/common-validators'
import {
  buildTaxReport,
  taxReportToCsvRows,
  TAX_REPORT_CSV_HEADERS,
  MethodMismatchError,
} from '../tax/report'
import { AccountingMethod } from '@prisma/client'
import { toCsv } from '../utils/csv'
import goalsRouter from './goals'

const router = Router()

// Mounted before the /:userId route below so a literal "goals" first segment
// is never captured as a userId.
router.use('/goals', goalsRouter)

const portfolioSchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
})

const taxReportSchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
  query: z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    format: z.enum(['json', 'csv']).default('json'),
    // #317 — whitelisted against the AccountingMethod enum (never a raw
    // string into a switch/ORDER BY); optional confirmation gate, not a
    // recompute switch — see src/tax/report.ts's buildTaxReport.
    method: z.nativeEnum(AccountingMethod).optional(),
  }),
})

const historySchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
  query: z.object({
    period: z.enum(['7d', '30d', '90d']).default('30d'),
  }),
})

/**
 * Portfolio optimization (#322).
 *
 * Registered BEFORE `GET /:userId` for the same defensive reason as the
 * `/goals` mount above: these live under `/:userId/...` so they cannot actually
 * collide, but keeping every more-specific route ahead of the bare `/:userId`
 * means a future path never silently becomes a user ID.
 *
 * Both are keyed on `req.params.userId`, which is what keeps `enforceUserAccess`
 * effective. A body-only or resource-id-keyed route (`/suggestions/:id`) would
 * make that middleware a silent no-op — the trap documented in CLAUDE.md — and
 * would also skip the sub-account permission lookup, which reads the same param.
 */

/**
 * One optimization per user at a time, and a small global budget.
 *
 * Module-level so the limiter is shared across every request in the process,
 * which is the only scope at which "how many solves are running on this event
 * loop" is a meaningful question. See src/utils/concurrency.ts for why this
 * exists in addition to the rate limiter.
 */
const optimizerConcurrency = new ConcurrencyLimiter({
  globalLimit: config.allocationSuggestions.maxConcurrent,
  perKeyLimit: 1,
})

router.post(
  '/:userId/suggest-allocation',
  requireAuth,
  enforceUserAccess,
  optimizerRateLimiter,
  validate(suggestAllocationSchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const body = req.body as {
      lookbackDays: number
      frontierPoints: number
      includeBacktest: boolean
    }

    const slot = optimizerConcurrency.tryAcquire(userId)
    if (isAcquireFailure(slot)) {
      logger.warn('[Analytics] Optimization rejected — concurrency limit', {
        userId,
        scope: slot.scope,
        inFlight: optimizerConcurrency.inFlight,
      })
      res.setHeader('Retry-After', '5')
      return res.status(429).json({
        error:
          slot.scope === 'key'
            ? 'An optimization is already running for this account. Please wait for it to finish.'
            : 'The optimizer is busy. Please try again in a few seconds.',
      })
    }

    try {
      const result = await suggestAllocation(userId, {
        lookbackDays: body.lookbackDays,
        frontierPoints: body.frontierPoints,
        runBacktest: body.includeBacktest,
      })
      return res.status(200).json(result)
    } catch (error) {
      if (error instanceof SuggestionUserNotFoundError) {
        return sendNotFound(res, 'User')
      }
      throw error
    } finally {
      // In `finally` so a throw cannot leak the slot and permanently wedge this
      // user out of the endpoint for the process lifetime.
      slot.release()
    }
  }
)

router.get(
  '/:userId/suggestions',
  requireAuth,
  enforceUserAccess,
  validate(listSuggestionsSchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const page = req.query.page as unknown as number
    const limit = req.query.limit as unknown as number

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) {
      return sendNotFound(res, 'User')
    }

    const [total, rows] = await Promise.all([
      db.allocationSuggestion.count({ where: { userId } }),
      db.allocationSuggestion.findMany({
        where: { userId },
        orderBy: { computedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])

    return res.status(200).json({
      userId,
      isSuggestion: true,
      page,
      limit,
      total,
      suggestions: rows.map(mapAllocationSuggestionToResponse),
    })
  }
)

router.get(
  '/:userId',
  requireAuth,
  enforceUserAccess,
  validate(portfolioSchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const user = await db.user.findUnique({
      where: { id: userId },
    })

    if (!user) {
      return sendNotFound(res, 'User')
    }

    const userPositions = await db.position.findMany({
      where: { userId },
    })

    const totalBalance = userPositions.reduce((sum: number, position: any) => {
      return sum + Number(position.currentValue)
    }, 0)
    const totalEarnings = userPositions.reduce((sum: number, position: any) => {
      return sum + Number(position.yieldEarned)
    }, 0)
    const activePositions = userPositions.filter(
      (p: any) => p.status === 'ACTIVE'
    ).length

    const positions = userPositions.map(mapPositionToResponse)

    return res.status(200).json({
      userId: user.id,
      totalBalance,
      totalEarnings,
      activePositions,
      positions,
      whatsappReply: formatPortfolioReply({
        totalBalance,
        totalEarnings,
        activePositions,
        positions,
      }),
    })
  }
)

router.get(
  '/:userId/history',
  requireAuth,
  enforceUserAccess,
  validate(historySchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })

    if (!user) {
      return sendNotFound(res, 'User')
    }

    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const periodDays =
      req.query.period === '7d' ? 7 : req.query.period === '30d' ? 30 : 90
    const fromDate = new Date(now - periodDays * dayMs)

    const snapshots = await db.yieldSnapshot.findMany({
      where: { position: { is: { userId } }, snapshotAt: { gte: fromDate } },
      orderBy: { snapshotAt: 'desc' },
      take: 30,
    })

    const points = snapshots.map((snapshot: any) => ({
      date: snapshot.snapshotAt.toISOString().slice(0, 10),
      yieldAmount: Number(snapshot.yieldAmount),
    }))

    return res.status(200).json({
      userId,
      period: req.query.period,
      points,
      whatsappReply: formatPortfolioHistoryReply({
        period: req.query.period as any,
        points,
      }),
    })
  }
)

router.get(
  '/:userId/earnings',
  requireAuth,
  enforceUserAccess,
  validate(portfolioSchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const user = await db.user.findUnique({
      where: { id: userId },
    })

    if (!user) {
      return sendNotFound(res, 'User')
    }

    const userPositions = await db.position.findMany({
      where: { userId },
    })

    const snapshots = await db.yieldSnapshot.findMany({
      where: { position: { is: { userId } } },
      orderBy: { snapshotAt: 'desc' },
      take: 30,
    })

    const totalEarnings = userPositions.reduce((sum: number, position: any) => {
      return sum + Number(position.yieldEarned)
    }, 0)
    const periodEarnings = snapshots.reduce((sum: number, snapshot: any) => {
      return sum + Number(snapshot.yieldAmount)
    }, 0)
    const averageApy =
      snapshots.length > 0
        ? snapshots.reduce(
            (sum: number, snapshot: any) => sum + Number(snapshot.apy),
            0
          ) / snapshots.length
        : 0

    return res.status(200).json({
      userId,
      totalEarnings,
      periodEarnings,
      averageApy,
      whatsappReply: formatPortfolioEarningsReply({
        totalEarnings,
        periodEarnings,
        averageApy,
      }),
    })
  }
)

router.get(
  '/:userId/tax-report',
  requireAuth,
  enforceUserAccess,
  validate(taxReportSchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })

    if (!user) {
      return sendNotFound(res, 'User')
    }

    const year = req.query.year as unknown as number
    const method = req.query.method as AccountingMethod | undefined

    let report
    try {
      report = await buildTaxReport(userId, year, method)
    } catch (err) {
      if (err instanceof MethodMismatchError) {
        return res.status(400).json({ error: err.message })
      }
      throw err
    }

    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tax-report-${year}.csv"`
      )
      return res
        .status(200)
        .send(toCsv(TAX_REPORT_CSV_HEADERS, taxReportToCsvRows(report)))
    }

    return res.status(200).json(report)
  }
)

export default router
