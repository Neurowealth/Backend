import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { paginationSchema, getPaginationParams } from '../utils/pagination'
import { mapTransactionToResponse } from '../utils/api-formatters'
import { sendNotFound } from '../utils/errors'
import {
  formatTransactionDetailReply,
  formatTransactionsReply,
} from '../whatsapp/formatters'
import { recordTransactionEvent } from '../utils/transaction-events'

// ─── Schemas ──────────────────────────────────────────────────────────────────

const txHashParamSchema = z.object({
  txHash: z.string().min(1, 'Transaction hash is required'),
})

const listSchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
  query: paginationSchema,
})

// ─── Router ───────────────────────────────────────────────────────────────────

const router = Router()

/**
 * GET /transactions/detail/:txHash
 * Returns full detail for a single transaction owned by the authenticated user.
 */
router.get(
  '/detail/:txHash',
  requireAuth,
  validate({ params: txHashParamSchema }),
  async (req: Request, res: Response) => {
    const txHash = String(req.params.txHash)

    const tx = await db.transaction.findUnique({ where: { txHash } })

    if (!tx || tx.userId !== req.auth?.userId) {
      return sendNotFound(res, 'Transaction')
    }

    const item = mapTransactionToResponse(tx)

    return res.status(200).json({
      transaction: item,
      whatsappReply: formatTransactionDetailReply(item),
    })
  },
)

/**
 * GET /transactions/:userId
 * Returns a paginated list of transactions for the given user.
 * Requires the caller to be that user (enforceUserAccess).
 */
router.get(
  '/:userId',
  requireAuth,
  enforceUserAccess,
  validate(listSchema),
  async (req: Request, res: Response) => {
    const userId = String(req.params.userId)
    const { page, limit, skip } = getPaginationParams(req.query)

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) return sendNotFound(res, 'User')

    const [total, transactions] = await Promise.all([
      db.transaction.count({ where: { userId } }),
      db.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ])

    const items = transactions.map(mapTransactionToResponse)

    return res.status(200).json({
      page,
      limit,
      total,
      transactions: items,
      whatsappReply: formatTransactionsReply({ page, limit, transactions: items }),
    })
  },  // ← closes the async handler for /:userId
)     // ← closes router.get('/:userId', ...)

/**
 * GET /transactions/:id/events
 * Returns the ordered event history for a transaction (admin only).
 */
router.get(
  '/:id/events',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = String(req.params.id)  // ← String() cast fixes the string | string[] error

    const tx = await db.transaction.findUnique({ where: { id } })
    if (!tx) return sendNotFound(res, 'Transaction')

    const events = await (db as any).transactionEvent.findMany({
      where: { transactionId: id },
      orderBy: { occurredAt: 'asc' },
    })

    return res.status(200).json({ transactionId: id, events })
  },
)

export default router