import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'
import { whatsappFormatters } from '../whatsapp/formatters'
import { logger } from '../utils/logger'

const router = Router()

// Validation schemas
const userIdSchema = z.string().uuid()
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(5)
})

const txHashSchema = z.string().min(40)

/**
 * GET /api/transactions/:userId?page=1&limit=5
 * Get paginated user transaction history
 * Default limit = 5 (WhatsApp readability)
 */
router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = userIdSchema.parse(req.params.userId)
    const { page, limit } = paginationSchema.parse({
      page: req.query.page,
      limit: req.query.limit
    })

    if (req.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot access other users transactions' })
      return
    }

    const user = await db.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' })
      return
    }

    // Calculate pagination
    const skip = (page - 1) * limit

    const [transactions, total] = await Promise.all([
      db.transaction.findMany({
        where: { userId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          position: {
            select: { protocolName: true }
          }
        }
      }),
      db.transaction.count({
        where: { userId: userId }
      })
    ])

    const totalPages = Math.ceil(total / limit)

    const transactionData = {
      userId,
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
      transactions: transactions.map((tx: any) => ({
        id: tx.id,
        type: tx.type,
        assetSymbol: tx.assetSymbol,
        amount: tx.amount.toString(),
        fee: tx.fee?.toString(),
        status: tx.status,
        protocol: tx.protocolName || tx.position?.protocolName,
        date: tx.createdAt.toISOString(),
        txHash: tx.txHash,
        memo: tx.memo
      })),
      whatsappReply: whatsappFormatters.formatTransactionHistory({
        transactions: transactions.map((tx: any) => ({
          type: tx.type,
          assetSymbol: tx.assetSymbol,
          amount: tx.amount.toString(),
          status: tx.status,
          date: tx.createdAt.toLocaleDateString()
        })),
        hasMore: page < totalPages,
        page
      })
    }

    res.status(200).json(transactionData)
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.issues })
      return
    }
    logger.error('Transactions endpoint error', { error, userId: req.params.userId })
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/transactions/detail/:txHash
 * Get detailed information about a single transaction
 */
router.get('/detail/:txHash', requireAuth, async (req: Request, res: Response) => {
  try {
    const txHash = txHashSchema.parse(req.params.txHash)

    const transaction = await db.transaction.findUnique({
      where: { txHash: txHash },
      include: {
        position: {
          select: { protocolName: true }
        }
      }
    })

    if (!transaction) {
      res.status(404).json({ error: 'Not Found', message: 'Transaction not found' })
      return
    }

    // Verify user can access this transaction
    if (transaction.userId !== req.userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot access other users transactions' })
      return
    }

    const transactionDetailData = {
      id: transaction.id,
      type: transaction.type,
      assetSymbol: transaction.assetSymbol,
      amount: transaction.amount.toString(),
      fee: transaction.fee?.toString(),
      status: transaction.status,
      protocol: transaction.protocolName || transaction.position?.protocolName,
      date: transaction.createdAt.toISOString(),
      txHash: transaction.txHash!,
      memo: transaction.memo,
      confirmedAt: transaction.confirmedAt?.toISOString(),
      whatsappReply: whatsappFormatters.formatTransactionDetail({
        type: transaction.type,
        assetSymbol: transaction.assetSymbol,
        amount: transaction.amount.toString(),
        fee: transaction.fee?.toString(),
        status: transaction.status,
        date: transaction.createdAt.toLocaleDateString(),
        txHash: transaction.txHash!,
        protocol: transaction.protocolName || transaction.position?.protocolName,
        memo: transaction.memo || undefined
      })
    }

    res.status(200).json(transactionDetailData)
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.issues })
      return
    }
    logger.error('Transaction detail endpoint error', { error, txHash: req.params.txHash })
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
