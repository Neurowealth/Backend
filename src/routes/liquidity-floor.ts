/**
 * Liquidity floor routes (#541), mounted under /api/v1/liquidity-floor.
 *
 * GET  /api/v1/liquidity-floor            — get caller's liquidity floor & standing status
 * GET  /api/v1/liquidity-floor/:userId    — get user's liquidity floor & standing status
 * PUT  /api/v1/liquidity-floor            — update caller's liquidity floor buffer
 * PUT  /api/v1/liquidity-floor/:userId    — update user's liquidity floor buffer
 * PATCH /api/v1/liquidity-floor           — alias for PUT
 * PATCH /api/v1/liquidity-floor/:userId   — alias for PUT
 */
import { Router } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { updateLiquidityFloorSchema } from '../validators/strategy-validators'
import {
  getLiquidityFloorHandler,
  updateLiquidityFloorHandler,
} from '../controllers/liquidity-floor-controller'

const router = Router()

router.get('/', requireAuth, getLiquidityFloorHandler)
router.get('/:userId', requireAuth, getLiquidityFloorHandler)

router.put(
  '/',
  requireAuth,
  validate({ body: updateLiquidityFloorSchema }),
  updateLiquidityFloorHandler
)
router.put(
  '/:userId',
  requireAuth,
  validate({ body: updateLiquidityFloorSchema }),
  updateLiquidityFloorHandler
)

router.patch(
  '/',
  requireAuth,
  validate({ body: updateLiquidityFloorSchema }),
  updateLiquidityFloorHandler
)
router.patch(
  '/:userId',
  requireAuth,
  validate({ body: updateLiquidityFloorSchema }),
  updateLiquidityFloorHandler
)

export default router
