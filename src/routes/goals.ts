/**
 * Goal-based investing routes (#281, #358), mounted under /api/v1/goals and
 * /api/v1/portfolio/goals.
 *
 *   GET    /                        — list caller's goals with progress + allocation (#358)
 *   POST   /                        — create a savings goal
 *   GET    /:userId                 — the user's current goal (owner-scoped)
 *   PATCH  /:id                     — update target amount/date/riskCeiling/priority/weight/mode
 *   PUT    /:id                     — update target amount/date/riskCeiling/priority/weight/mode (#358)
 *   POST   /:id/reassign            — manually reassign attributed capital between goals (#358)
 *   DELETE /:id                     — cancel (soft) a goal
 *   GET    /:id/progress            — trajectory + reachability
 *   POST   /:id/simulate            — Monte Carlo goal attainment probability (#319)
 */
import { Router } from 'express'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { validate } from '../middleware/validate'
import { userIdParamSchema } from '../validators/common-validators'
import {
  createGoalSchema,
  updateGoalSchema,
  reassignGoalSchema,
  goalIdParamSchema,
} from '../validators/goal-validators'
import {
  listGoalsHandler,
  createGoalHandler,
  getGoalHandler,
  updateGoalHandler,
  reassignGoalHandler,
  cancelGoalHandler,
  getGoalProgressHandler,
} from '../controllers/goal-controller'
import { simulateGoalHandler } from '../controllers/goal-simulation-controller'
import { simulateGoalSchema } from '../validators/simulation-validators'

const router = Router()

router.get('/', requireAuth, listGoalsHandler)

router.post(
  '/',
  requireAuth,
  requireScope('goals:write'),
  idempotent({ required: false, ttlSeconds: 86400 }),
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
  requireScope('goals:write'),
  validate({ params: goalIdParamSchema, body: updateGoalSchema }),
  updateGoalHandler
)

router.put(
  '/:id',
  requireAuth,
  requireScope('goals:write'),
  validate({ params: goalIdParamSchema, body: updateGoalSchema }),
  updateGoalHandler
)

router.post(
  '/:id/reassign',
  requireAuth,
  requireScope('goals:write'),
  validate({ params: goalIdParamSchema, body: reassignGoalSchema }),
  reassignGoalHandler
)

router.delete(
  '/:id',
  requireAuth,
  requireScope('goals:write'),
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
