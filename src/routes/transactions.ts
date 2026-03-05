import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { enforceUserAccess, requireAuth } from '../middleware/auth'
import {
  formatTransactionDetailReply,
  formatTransactionsReply,
} from '../whatsapp/formatters'

const router = Router()

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(5),
})

router.get('/detail/:txHash', requireAuth, async (req: Request, res: Response) => {
  const txHash = String(req.params.txHash)
  const tx = await db.transaction.findUnique({
    where: { txHash },
  })

  if (!tx || tx.userId !== req.auth?.userId) {
    return res.status(404).json({ error: 'Transaction not found' })
  }

  const item = {
    id: tx.id,
    txHash: tx.txHash,
    type: tx.type,
    status: tx.status,
    amount: Number(tx.amount),
    assetSymbol: tx.assetSymbol,
    protocolName: tx.protocolName,
    createdAt: tx.createdAt.toISOString(),
  }

  return res.status(200).json({
    transaction: item,
    whatsappReply: formatTransactionDetailReply(item),
  })
})

router.get('/:userId', requireAuth, enforceUserAccess, async (req: Request, res: Response) => {
  const userId = String(req.params.userId)
  const queryParsed = listQuerySchema.safeParse(req.query)
  if (!queryParsed.success) {
    return res.status(400).json({
      error: 'Validation error',
      details: queryParsed.error.flatten(),
    })
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const page = queryParsed.data.page
  const limit = queryParsed.data.limit || 5
  const skip = (page - 1) * limit

  const [total, transactions] = await Promise.all([
    db.transaction.count({ where: { userId } }),
    db.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ])

  const items = transactions.map((tx) => ({
    id: tx.id,
    txHash: tx.txHash,
    type: tx.type,
    status: tx.status,
    amount: Number(tx.amount),
    assetSymbol: tx.assetSymbol,
    protocolName: tx.protocolName,
    createdAt: tx.createdAt.toISOString(),
  }))

  return res.status(200).json({
    page,
    limit,
    total,
    transactions: items,
    whatsappReply: formatTransactionsReply({ page, limit, transactions: items }),
  })
})

export default router
