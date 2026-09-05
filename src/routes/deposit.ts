import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { validate } from '../middleware/validate'
import { processOnChainTransaction } from '../controllers/transaction-controller'

const router = Router()

// Validation schema for deposit requests. Ensures the caller provides a
// valid user ID, a positive deposit amount, and a recognized asset symbol,
// with optional protocol name and a short memo/note.
const depositSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().positive(),
  assetSymbol: z.string().min(1),
  protocolName: z.string().min(1).optional(),
  memo: z.string().max(280).optional(),
})

// POST / — Initiates an on-chain deposit transaction.
// Middleware chain:
//   1. requireAuth  — ensures the request is authenticated
//   2. validate     — validates req.body against depositSchema
// On success, delegates the actual transaction processing to the shared
// controller, tagging it as a 'DEPOSIT' operation.
router.post(
  '/',
  requireAuth,
  requireScope('deposit:write'),
  validate({ body: depositSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    return processOnChainTransaction(req, res, 'DEPOSIT')
  }
)

export default router
