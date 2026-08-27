// src/controllers/strategy-controller.ts
// Strategy marketplace (#285): publish/unpublish a strategy, browse the
// leaderboard, follow/unfollow. HTTP shaping only — every business rule and
// every privacy decision lives in src/strategy/service.ts.
import { Request, Response } from 'express'
import { logger } from '../utils/logger'
import {
  sendError,
  sendNotFound,
  sendUnauthorized,
  sendConflict,
} from '../utils/errors'
import {
  mapFollowToResponse,
  mapMarketplaceEntryToResponse,
  mapPublishedStrategyToResponse,
} from '../utils/api-formatters'
import {
  publishStrategy,
  unpublishStrategy,
  getMarketplace,
  getActiveFollow,
  followStrategy,
  unfollowStrategy,
  StrategyNotFoundError,
  StrategyFollowNotFoundError,
  StrategySelfFollowError,
  StrategyValidationError,
} from '../strategy/service'

/**
 * POST /api/v1/strategies/publish
 *
 * Publishes the caller's own strategy. There is no "publish on behalf of"
 * form — the caller is always the publisher, which is why PublishedStrategy.userId
 * is unique and this is an upsert.
 */
export async function publishStrategyHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.auth?.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const { strategy, materialChange } = await publishStrategy(userId, req.body)
    res.status(200).json({
      strategy: mapPublishedStrategyToResponse(strategy),
      materialChange,
    })
  } catch (error) {
    if (error instanceof StrategyValidationError) {
      sendError(res, 400, error.message)
      return
    }
    if (error instanceof StrategyNotFoundError) {
      sendNotFound(res, 'Strategy')
      return
    }
    logger.error('[Strategy] Failed to publish strategy:', error)
    sendError(res, 500, 'Failed to publish strategy')
  }
}

/**
 * POST /api/v1/strategies/unpublish
 *
 * Delists immediately. Followers keep their applied config — see the service.
 */
export async function unpublishStrategyHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.auth?.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const strategy = await unpublishStrategy(userId)
    res.status(200).json({ strategy: mapPublishedStrategyToResponse(strategy) })
  } catch (error) {
    if (error instanceof StrategyNotFoundError) {
      sendNotFound(res, 'Published strategy')
      return
    }
    logger.error('[Strategy] Failed to unpublish strategy:', error)
    sendError(res, 500, 'Failed to unpublish strategy')
  }
}

/**
 * GET /api/v1/strategies/marketplace
 *
 * Flat `{ page, limit, total, strategies }` envelope, matching the only other
 * endpoint using shared pagination (src/routes/transactions.ts).
 */
export async function getMarketplaceHandler(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const query = req.query as unknown as Parameters<typeof getMarketplace>[0]
    const result = await getMarketplace(query)

    res.status(200).json({
      page: result.page,
      limit: result.limit,
      total: result.total,
      window: result.window,
      sortBy: result.sortBy,
      strategies: result.entries.map(mapMarketplaceEntryToResponse),
    })
  } catch (error) {
    logger.error('[Strategy] Failed to load marketplace:', error)
    sendError(res, 500, 'Failed to load strategy marketplace')
  }
}

/**
 * GET /api/v1/strategies/following
 *
 * `{ follow: null }` rather than a 404 — "I follow nothing" is a normal state,
 * not a missing resource.
 */
export async function getFollowingHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.auth?.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const follow = await getActiveFollow(userId)
    res
      .status(200)
      .json({ follow: follow ? mapFollowToResponse(follow) : null })
  } catch (error) {
    logger.error('[Strategy] Failed to load active follow:', error)
    sendError(res, 500, 'Failed to load followed strategy')
  }
}

/**
 * POST /api/v1/strategies/:id/follow
 *
 * `:id` is a PublishedStrategy id, never a userId — see the note in
 * src/validators/strategy-validators.ts about enforceUserAccess.
 */
export async function followStrategyHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.auth?.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const follow = await followStrategy(userId, String(req.params.id))
    res.status(201).json({ follow: mapFollowToResponse(follow) })
  } catch (error) {
    if (error instanceof StrategySelfFollowError) {
      sendConflict(res, error.message)
      return
    }
    if (error instanceof StrategyNotFoundError) {
      sendNotFound(res, 'Published strategy')
      return
    }
    logger.error('[Strategy] Failed to follow strategy:', error)
    sendError(res, 500, 'Failed to follow strategy')
  }
}

/**
 * POST /api/v1/strategies/:id/unfollow
 */
export async function unfollowStrategyHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.auth?.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const result = await unfollowStrategy(userId, String(req.params.id))
    res.status(200).json({
      id: result.id,
      unfollowedAt: result.unfollowedAt.toISOString(),
    })
  } catch (error) {
    if (error instanceof StrategyFollowNotFoundError) {
      sendNotFound(res, 'Active follow')
      return
    }
    logger.error('[Strategy] Failed to unfollow strategy:', error)
    sendError(res, 500, 'Failed to unfollow strategy')
  }
}
