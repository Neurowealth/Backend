import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/auth'
import {
  getActiveProtocol,
  getOnChainAPY,
  getOnChainBalance,
  buildUnsignedVaultTransaction,
} from '../stellar/contract'

const router = Router()

function toNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

router.get('/state', async (req: Request, res: Response) => {
  const [apy, activeProtocol] = await Promise.all([
    getOnChainAPY(),
    getActiveProtocol(),
  ])

  return res.status(200).json({
    apy,
    activeProtocol,
  })
})

router.get('/balance', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth?.userId
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { walletAddress: true },
  })

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const onChain = await getOnChainBalance(user.walletAddress)

  return res.status(200).json({
    balance: toNumber(onChain.balance),
    shares: toNumber(onChain.shares),
  })
})

const buildTransactionSchema = z.object({
  type: z.enum(['deposit', 'withdraw']),
  amount: z.number().positive(),
  assetSymbol: z.string().min(1),
})

/**
 * POST /vault/build-transaction
 * Builds an unsigned XDR transaction for the user to sign client-side (non-custodial).
 * The backend never holds or decrypts private keys for this flow.
 */
router.post('/build-transaction', requireAuth, async (req: Request, res: Response) => {
  const parsed = buildTransactionSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const walletAddress = req.auth!.walletAddress

  const unsignedXdr = await buildUnsignedVaultTransaction(
    parsed.data.type,
    walletAddress,
    parsed.data.amount,
    parsed.data.assetSymbol,
  )

  return res.status(200).json({
    xdr: unsignedXdr,
    type: parsed.data.type,
    amount: parsed.data.amount,
    walletAddress,
  })
})

export default router
