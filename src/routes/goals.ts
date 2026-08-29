/**
 * Goal-based investing routes (#281), mounted under /api/portfolio/goals.
 *
 *   POST   /api/portfolio/goals            — create the caller's savings goal
 *   GET    /api/portfolio/goals/:userId     — the user's current goal (owner-scoped)
 *   PATCH  /api/portfolio/goals/:id         — update target amount/date/riskCeiling
 *   DELETE /api/portfolio/goals/:id         — cancel (soft) a goal
 *   GET    /api/portfolio/goals/:id/progress — trajectory + reachability
 *
 * PATCH/DELETE/progress are keyed by goal id, not :userId, so enforceUserAccess
 * doesn't apply to them — ownership is checked explicitly in the controller.
 */
import { Router } from 'express'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { userIdParamSchema } from '../validators/common-validators'
import {
  createGoalSchema,
  updateGoalSchema,
  goalIdParamSchema,
} from '../validators/goal-validators'
import {
  createGoalHandler,
  getGoalHandler,
  updateGoalHandler,
  cancelGoalHandler,
  getGoalProgressHandler,
} from '../controllers/goal-controller'
import { simulateGoalHandler } from '../controllers/goal-simulation-controller'
import { simulateGoalSchema } from '../validators/simulation-validators'

const router = Router()

router.post(
  '/',
  requireAuth,
  validate({ body: createGoalSchema }),
  createGoalHandler
)

router.get(
  '/:userId',
  requireAuth,
  enforceUserAccess,
  validate({ params: userIdParamSchema }),
  getGoalHandler
)

router.patch(
  '/:id',
  requireAuth,
  validate({ params: goalIdParamSchema, body: updateGoalSchema }),
  updateGoalHandler
)

router.delete(
  '/:id',
  requireAuth,
  validate({ params: goalIdParamSchema }),
  cancelGoalHandler
)

router.get(
  '/:id/progress',
  requireAuth,
  validate({ params: goalIdParamSchema }),
  getGoalProgressHandler
)

/**
 * POST /:id/simulate — Monte Carlo goal attainment probability (#319).
 *
 * Owner-scoped: the caller must own the goal. Returns attainment probability,
 * percentile bands, sensitivity table, and an isSimulation disclaimer.
 * Insufficient history returns an explicit insufficient_history outcome,
 * not a guessed probability.
 */
router.post(
  '/:id/simulate',
  requireAuth,
  validate(simulateGoalSchema),
  simulateGoalHandler
)

export default router
