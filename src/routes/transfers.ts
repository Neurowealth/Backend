import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { sensitiveRateLimiter } from '../middleware/rateLimiter'
import { validate } from '../middleware/validate'
import { onChainAmountSchema } from '../validators/common-validators'
import { executeInternalTransfer } from '../services/internal-transfer.service'

const router = Router()

const transferSchema = z.object({
  recipientHandle: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NP-Z2-9]{8}$/, 'Invalid recipient handle'),
  amount: onChainAmountSchema,
  assetSymbol: z.string().trim().min(1).max(32),
  note: z.string().max(280).optional(),
  acknowledgeGoalImpact: z.boolean().optional(),
})

router.post(
  '/',
  requireAuth,
  requireScope('transfer:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  sensitiveRateLimiter,
  validate({ body: transferSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await executeInternalTransfer({
        senderUserId: req.auth!.userId,
        ...req.body,
      })
      res.status(201).json({
        transferId: result.transferId,
        transactionId: result.transactionId,
        recipientHandle: result.recipientHandle,
        assetSymbol: result.assetSymbol,
        amount: result.amount,
        status: 'CONFIRMED',
      })
    } catch (error) {
      next(error)
    }
  }
)

export default router
