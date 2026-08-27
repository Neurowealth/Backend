import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/authenticate'
import { requireScope, requireWithdrawScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { requireSubAccountPermission } from '../middleware/subAccount'
import { validate } from '../middleware/validate'
import { processOnChainTransaction } from '../controllers/transaction-controller'

const router = Router()

const withdrawSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().positive(),
  assetSymbol: z.string().min(1),
  protocolName: z.string().min(1).optional(),
  memo: z.string().max(280).optional(),
  // #317 — required only when the user's accountingMethod is SPECIFIC_ID;
  // ignored otherwise. Enforced in src/tax/service.ts at disposal-recording
  // time, not here — this route has no tax-module awareness.
  selectedLotIds: z.array(z.string().uuid()).optional(),
})

router.post(
  '/',
  requireAuth,
  requireScope('withdraw:write'),
  requireWithdrawScope,
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({ body: withdrawSchema, errorMessage: 'Validation error' }),
  requireSubAccountPermission('WITHDRAW'),
  async (req: Request, res: Response) => {
    return processOnChainTransaction(req, res, 'WITHDRAWAL')
  }
)

export default router
