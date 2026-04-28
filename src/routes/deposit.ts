import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/auth'
import { depositForUser } from '../stellar/contract'
import { formatDepositReply } from '../whatsapp/formatters'
import { validate } from '../middleware/validate'

const router = Router()

const depositSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().positive(),
  assetSymbol: z.string().min(1),
  protocolName: z.string().min(1).optional(),
  memo: z.string().max(280).optional(),
})

router.post('/', requireAuth, validate({ body: depositSchema, errorMessage: 'Validation error' }), async (req: Request, res: Response) => {
  const parsed = req.body
  const auth = req.auth

  if (!auth || auth.userId !== parsed.userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const user = await db.user.findUnique({
    where: { id: parsed.userId },
    select: { id: true, network: true },
  })
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const onChainTransaction = await depositForUser(
    parsed.userId,
    auth.walletAddress,
    parsed.amount,
    parsed.assetSymbol,
  )

  const transactionStatus =
    onChainTransaction.status === 'success' ? 'CONFIRMED' : 'FAILED'

  const existing = await db.transaction.findUnique({
    where: { txHash: onChainTransaction.hash },
    select: { id: true },
  })

  if (existing) {
    return res.status(409).json({ error: 'Duplicate transaction hash' })
  }

  const transaction = await db.transaction.create({
    data: {
      userId: parsed.userId,
      txHash: onChainTransaction.hash,
      type: 'DEPOSIT',
      status: transactionStatus,
      assetSymbol: parsed.assetSymbol,
      amount: parsed.amount,
      network: user.network,
      protocolName: parsed.protocolName,
      memo: parsed.memo,
      confirmedAt:
        transactionStatus === 'CONFIRMED' ? new Date() : null,
    },
  })

  return res.status(201).json({
    txHash: transaction.txHash,
    status: transaction.status,
    transaction: {
      id: transaction.id,
      txHash: transaction.txHash,
      status: transaction.status,
      amount: Number(transaction.amount),
      assetSymbol: transaction.assetSymbol,
      protocolName: transaction.protocolName,
    },
    whatsappReply: formatDepositReply({
      amount: Number(transaction.amount),
      assetSymbol: transaction.assetSymbol,
      protocolName: transaction.protocolName,
    }),
  })
})

export default router
