/**
 * Agent decisions — explainable rebalance rationale ledger (#343).
 *
 * User-facing:
 *   GET /api/v1/agent/decisions        — list own decisions (paginated, filterable)
 *   GET /api/v1/agent/decisions/:id    — detail, including ranked candidates
 *
 * A decision is visible to a user iff they are in `affectedUserIds`. Responses
 * are projected per-user: `affectedUserIds` is stripped, `affectedPositions`
 * is not exposed (batch-level count), and candidates/amounts are never per-user
 * (they are batch-level APYs) so no other user's position size leaks.
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { logger } from '../utils/logger'
import { sendNotFound } from '../utils/errors'

const router = Router()

// Use `any` for Prisma JSON fields / Decimal round-trip to avoid
// over-coupling these mappers to generated client types.
type DecisionRow = any

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  // Prisma Decimal has toNumber(); fallback to Number()
  if (
    typeof value === 'object' &&
    value !== null &&
    'toNumber' in (value as any)
  ) {
    try {
      return (value as any).toNumber()
    } catch {
      return Number(value as any)
    }
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function mapForUser(row: DecisionRow, outboxStatus?: string | null) {
  return {
    id: row.id,
    correlationId: row.correlationId,
    batchKey: row.batchKey,
    fromProtocol: row.fromProtocol,
    toProtocol: row.toProtocol ?? null,
    outcome: row.outcome,
    blockedReason: row.blockedReason ?? null,
    strategyName: row.strategyName ?? null,
    strategyIsFollowed: row.strategyIsFollowed,
    followedStrategyId: row.followedStrategyId ?? null,
    thresholds: row.thresholds,
    currentApy: toNumber(row.currentApy),
    chosenApy: toNumber(row.chosenApy),
    rawImprovement: toNumber(row.rawImprovement),
    estCostPercent: toNumber(row.estCostPercent),
    netImprovement: toNumber(row.netImprovement),
    candidates: row.candidates ?? [],
    rationale: row.rationale ?? null,
    outboxOpId: row.outboxOpId ?? null,
    outboxStatus: outboxStatus ?? null,
    heldSince: row.heldSince ? new Date(row.heldSince).toISOString() : null,
    lastEvaluatedAt: row.lastEvaluatedAt
      ? new Date(row.lastEvaluatedAt).toISOString()
      : null,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

// Admin mapper — includes affectedUserIds / affectedPositions
function mapForAdmin(row: DecisionRow, outboxStatus?: string | null) {
  return {
    ...mapForUser(row, outboxStatus),
    affectedUserIds: row.affectedUserIds,
    affectedPositions: row.affectedPositions,
  }
}

const listQuerySchema = z.object({
  outcome: z.enum(['REBALANCED', 'HELD', 'BLOCKED']).optional(),
  fromProtocol: z.string().min(1).max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

const idParamSchema = z.object({
  id: z.string().uuid(),
})

/**
 * GET /api/v1/agent/decisions
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId

  const parsed = listQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: parsed.error.flatten() })
  }

  const { outcome, fromProtocol, from, to, page, limit } = parsed.data
  const skip = (page - 1) * limit

  const where: any = {
    affectedUserIds: { has: userId },
  }
  if (outcome) where.outcome = outcome
  if (fromProtocol) where.fromProtocol = fromProtocol
  if (from || to) {
    where.createdAt = {}
    if (from) where.createdAt.gte = new Date(from)
    if (to) where.createdAt.lte = new Date(to)
  }

  try {
    const [total, rows] = await Promise.all([
      (db as any).rebalanceDecision.count({ where }),
      (db as any).rebalanceDecision.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ])

    // Join outbox status for REBALANCED rows (best-effort, single query)
    const outboxIds = rows
      .map((r: DecisionRow) => r.outboxOpId)
      .filter(Boolean) as string[]
    let statusByOpId = new Map<string, string>()
    if (outboxIds.length > 0) {
      const ops = await (db as any).outboxOp.findMany({
        where: { id: { in: outboxIds } },
        select: { id: true, status: true },
      })
      statusByOpId = new Map(ops.map((o: any) => [o.id, o.status]))
    }

    const data = rows.map((row: DecisionRow) =>
      mapForUser(
        row,
        row.outboxOpId ? (statusByOpId.get(row.outboxOpId) ?? null) : null
      )
    )

    return res.status(200).json({
      page,
      limit,
      total,
      decisions: data,
    })
  } catch (error) {
    logger.error('[AgentDecisions] List failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return res.status(500).json({ error: 'Failed to list decisions' })
  }
})

/**
 * GET /api/v1/agent/decisions/:id
 */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = idParamSchema.safeParse(req.params)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid decision id' })
  }

  const { id } = parsed.data

  try {
    const row = (await (db as any).rebalanceDecision.findFirst({
      where: { id, affectedUserIds: { has: userId } },
    })) as DecisionRow | null

    if (!row) return sendNotFound(res, 'Decision')

    let outboxStatus: string | null = null
    if (row.outboxOpId) {
      const op = await (db as any).outboxOp.findUnique({
        where: { id: row.outboxOpId },
        select: { status: true },
      })
      outboxStatus = op?.status ?? null
    }

    return res.status(200).json(mapForUser(row, outboxStatus))
  } catch (error) {
    logger.error('[AgentDecisions] Detail failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return res.status(500).json({ error: 'Failed to get decision' })
  }
})

export default router
export { mapForUser, mapForAdmin }
