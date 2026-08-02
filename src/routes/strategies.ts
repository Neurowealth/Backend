/**
 * Strategy marketplace routes (#285).
 *
 *   POST /api/v1/strategies/publish        — auth; upsert + publish the caller's own strategy
 *   POST /api/v1/strategies/unpublish      — auth; delist immediately
 *   GET  /api/v1/strategies/marketplace    — auth; ranked, anonymized leaderboard
 *   GET  /api/v1/strategies/following      — auth; what the caller currently follows
 *   POST /api/v1/strategies/:id/follow     — auth
 *   POST /api/v1/strategies/:id/unfollow   — auth
 *
 * A top-level resource rather than the issue's proposed /api/agent/strategies/*:
 * src/routes/agent.ts sits behind internalAuthGuard, an operator/machine guard
 * that authenticates by INTERNAL_SERVICE_TOKEN and sets no req.userId. These are
 * user-facing routes and cannot live there.
 *
 * `:id` is a PublishedStrategy id, deliberately not `:userId` —
 * enforceUserAccess compares req.params.userId against the caller and would
 * reject every follow request. Ownership is instead enforced inside the service
 * (publish/unpublish act on the caller; follow/unfollow act on the caller's own
 * follow row).
 */
import { Router } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import {
  publishStrategySchema,
  marketplaceQuerySchema,
  strategyIdParamSchema,
} from '../validators/strategy-validators'
import {
  publishStrategyHandler,
  unpublishStrategyHandler,
  getMarketplaceHandler,
  getFollowingHandler,
  followStrategyHandler,
  unfollowStrategyHandler,
} from '../controllers/strategy-controller'

const router = Router()

// Every route in this file is user-facing and owner-scoped.
router.use(requireAuth)

// Literal segments first, so "publish"/"marketplace"/"following" are never
// captured as a strategy id by the /:id/* routes below.
router.post(
  '/publish',
  validate({ body: publishStrategySchema }),
  publishStrategyHandler
)

router.post('/unpublish', unpublishStrategyHandler)

router.get(
  '/marketplace',
  validate({ query: marketplaceQuerySchema }),
  getMarketplaceHandler
)

router.get('/following', getFollowingHandler)

router.post(
  '/:id/follow',
  validate({ params: strategyIdParamSchema }),
  followStrategyHandler
)

router.post(
  '/:id/unfollow',
  validate({ params: strategyIdParamSchema }),
  unfollowStrategyHandler
)

export default router
