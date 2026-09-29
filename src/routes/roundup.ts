import { Router } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { validate } from '../middleware/validate'
import {
  updateRoundUpSettingsSchema,
  triggerSweepSchema,
} from '../validators/roundup-validators'
import {
  getRoundUpSettingsHandler,
  updateRoundUpSettingsHandler,
  getRoundUpAccrualsHandler,
  triggerSweepHandler,
} from '../controllers/roundup-controller'

const router = Router()

router.get(
  '/settings',
  requireAuth,
  requireScope('round_up:read'),
  getRoundUpSettingsHandler
)

router.patch(
  '/settings',
  requireAuth,
  requireScope('round_up:write'),
  validate({
    body: updateRoundUpSettingsSchema,
    errorMessage: 'Validation error',
  }),
  updateRoundUpSettingsHandler
)

router.get(
  '/accrual',
  requireAuth,
  requireScope('round_up:read'),
  getRoundUpAccrualsHandler
)

router.post(
  '/sweep',
  requireAuth,
  requireScope('round_up:write'),
  idempotent({ required: false, failClosed: true, ttlSeconds: 3600 }),
  validate({
    body: triggerSweepSchema,
    errorMessage: 'Validation error',
  }),
  triggerSweepHandler
)

export default router
