import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth'
import { validate } from '../middleware/validate'
import { processOnChainTransaction } from '../controllers/transaction-controller'

const router = Router()

const depositSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().positive(),
  assetSymbol: z.string().min(1),
  protocolName: z.string().min(1).optional(),
  memo: z.string().max(280).optional(),
})

router.post(
  '/',
  requireAuth,
  validate({ body: depositSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    return processOnChainTransaction(req, res, 'DEPOSIT')
  }
)

export default router
