import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { enforceUserAccess, requireAuth } from '../middleware/auth'
import { validate } from '../middleware/validate'
import { paginationSchema, getPaginationParams } from '../utils/pagination'
import { mapTransactionToResponse } from '../utils/api-formatters'
import { sendNotFound } from '../utils/errors'
import {
  formatTransactionDetailReply,
  formatTransactionsReply,
} from '../whatsapp/formatters'

const router = Router()

const listSchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
  query: paginationSchema,
})

router.get('/detail/:txHash', requireAuth, async (req: Request, res: Response) => {
  const txHash = String(req.params.txHash)
  const tx = await db.transaction.findUnique({
    where: { txHash },
  })

  if (!tx || tx.userId !== req.auth?.userId) {
    return sendNotFound(res, 'Transaction')
  }

  const item = mapTransactionToResponse(tx)

  return res.status(200).json({
    transaction: item,
    whatsappReply: formatTransactionDetailReply(item),
  })
})

router.get('/:userId', requireAuth, enforceUserAccess, validate(listSchema), async (req: Request, res: Response) => {
  const userId = req.params.userId as string
  const { page, limit, skip } = getPaginationParams(req.query)

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!user) {
    return sendNotFound(res, 'User')
  }

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
})

export default router
