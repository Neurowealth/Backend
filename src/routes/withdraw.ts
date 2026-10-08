import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/authenticate'
import { requireScope, requireWithdrawScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { requireSubAccountPermission } from '../middleware/subAccount'
import { sensitiveRateLimiter } from '../middleware/rateLimiter'
import { validate } from '../middleware/validate'
import { processOnChainTransaction } from '../controllers/transaction-controller'
import { onChainAmountSchema } from '../validators/common-validators'

const router = Router()

const withdrawSchema = z.object({
  userId: z.string().uuid(),
  amount: onChainAmountSchema,
  assetSymbol: z.string().min(1),
  protocolName: z.string().min(1).optional(),
  memo: z.string().max(280).optional(),
  // #317 — required only when the user's accountingMethod is SPECIFIC_ID;
  // ignored otherwise. Enforced in src/tax/service.ts at disposal-recording
  // time, not here — this route has no tax-module awareness.
  selectedLotIds: z.array(z.string().uuid()).optional(),
  acknowledgeGoalImpact: z.boolean().optional(),
})

router.post(
  '/',
  requireAuth,
  requireScope('withdraw:write'),
  requireWithdrawScope,
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  // #473 — irreversible action, so it gets its own tight budget in addition to
  // the caller's general allowance. Placed after authentication so the limiter
  // can key on the real principal rather than the shared NAT address.
  sensitiveRateLimiter,
  validate({ body: withdrawSchema, errorMessage: 'Validation error' }),
  requireSubAccountPermission('WITHDRAW'),
  async (req: Request, res: Response, next) => {
    try {
      await processOnChainTransaction(req, res, 'WITHDRAWAL')
    } catch (error) {
      next(error)
    }
  }
)

export default router
