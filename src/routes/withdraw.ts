import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/auth'
import { formatWithdrawReply } from '../whatsapp/formatters'

const router = Router()

const withdrawSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().positive(),
  assetSymbol: z.string().min(1),
  protocolName: z.string().min(1).optional(),
  memo: z.string().max(280).optional(),
})

router.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = withdrawSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Validation error',
      details: parsed.error.flatten(),
    })
  }

  if (req.auth?.userId !== parsed.data.userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const user = await db.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, network: true },
  })
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const transaction = await db.transaction.create({
    data: {
      userId: parsed.data.userId,
      type: 'WITHDRAWAL',
      status: 'PENDING',
      assetSymbol: parsed.data.assetSymbol,
      amount: parsed.data.amount,
      network: user.network,
      protocolName: parsed.data.protocolName,
      memo: parsed.data.memo,
    },
  })

  return res.status(201).json({
    transaction: {
      id: transaction.id,
      txHash: transaction.txHash,
      status: transaction.status,
      amount: Number(transaction.amount),
      assetSymbol: transaction.assetSymbol,
      protocolName: transaction.protocolName,
    },
    whatsappReply: formatWithdrawReply({
      amount: Number(transaction.amount),
      assetSymbol: transaction.assetSymbol,
      protocolName: transaction.protocolName,
    }),
  })
})

export default router
