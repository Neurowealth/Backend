// src/controllers/goal-controller.ts
// Goal-based investing (#281, #358): create/read/update/cancel savings goals,
// list multiple concurrent goals with priority-weighted allocation, reassign
// attributed capital, and report progress.
import { Request, Response } from 'express'
import { logger } from '../utils/logger'
import {
  sendError,
  sendNotFound,
  sendUnauthorized,
  sendConflict,
} from '../utils/errors'
import { mapGoalToResponse } from '../utils/api-formatters'
import { formatGoalProgressReply } from '../whatsapp/formatters'
import {
  createGoal,
  getGoalForUser,
  getGoalById,
  updateGoal,
  cancelGoal,
  computeGoalProgress,
  listGoalsWithProgress,
  reassignGoalAllocation,
  GoalConflictError,
  GoalNotFoundError,
  GoalValidationError,
} from '../goals/service'

/**
 * GET /api/v1/goals (and /api/v1/portfolio/goals)
 *
 * Returns all of the caller's goals ordered by priority, each with its own
 * `GoalProgress`, attributed `currentAmount`, `portfolioShare`, and the
 * `unallocated` portfolio remainder (#358).
 */
export async function listGoalsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.auth?.userId ?? req.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const result = await listGoalsWithProgress(userId)
    res.status(200).json({
      goals: result.goals.map((item) => ({
        goal: mapGoalToResponse(item.goal),
        progress: item.progress,
        currentAmount: item.currentAmount,
        portfolioShare: item.portfolioShare,
      })),
      totalPortfolioAmount: result.totalPortfolioAmount,
      totalAttributed: result.totalAttributed,
      unallocated: result.unallocated,
      goalFundingMode: result.goalFundingMode,
    })
  } catch (error) {
    logger.error('[Goals] Failed to list goals:', error)
    sendError(res, 500, 'Failed to list savings goals')
  }
}

/**
 * POST /api/portfolio/goals (and /api/v1/goals)
 *
 * Create a savings goal for the caller. Multiple concurrent ACTIVE goals are
 * supported with priority and allocationWeight (#358).
 */
export async function createGoalHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.userId ?? req.auth?.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const goal = await createGoal(userId, req.body)
    res.status(201).json({ goal: mapGoalToResponse(goal) })
  } catch (error) {
    if (error instanceof GoalConflictError) {
      sendConflict(res, error.message)
      return
    }
    if (error instanceof GoalValidationError) {
      sendError(res, 400, error.message)
      return
    }
    logger.error('[Goals] Failed to create goal:', error)
    sendError(res, 500, 'Failed to create savings goal')
  }
}

/**
 * GET /api/portfolio/goals/:userId
 *
 * The user's current goal: their highest-priority ACTIVE goal if one exists,
 * otherwise their most recent goal. enforceUserAccess guarantees
 * req.auth.userId === :userId.
 */
export async function getGoalHandler(
  req: Request,
  res: Response
): Promise<void> {
  const userId = String(req.params.userId)

  try {
    const goal = await getGoalForUser(userId)
    if (!goal) {
      sendNotFound(res, 'Savings goal')
      return
    }
    res.status(200).json({ goal: mapGoalToResponse(goal) })
  } catch (error) {
    logger.error('[Goals] Failed to get goal:', error)
    sendError(res, 500, 'Failed to retrieve savings goal')
  }
}

/**
 * PATCH / PUT /api/portfolio/goals/:id (and /api/v1/goals/:id)
 *
 * Update target amount/date/riskCeiling/priority/allocationWeight/fundingMode.
 * Keyed by goal id (not :userId), so ownership is checked explicitly here.
 */
export async function updateGoalHandler(
  req: Request,
  res: Response
): Promise<void> {
  const authUserId = req.auth?.userId ?? req.userId
  if (!authUserId) {
    sendUnauthorized(res)
    return
  }

  const id = String(req.params.id)

  try {
    const existing = await getGoalById(id)
    if (!existing) {
      sendNotFound(res, 'Savings goal')
      return
    }
    if (existing.userId !== authUserId) {
      sendUnauthorized(res)
      return
    }

    const goal = await updateGoal(id, req.body)
    res.status(200).json({ goal: mapGoalToResponse(goal) })
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      sendNotFound(res, 'Savings goal')
      return
    }
    if (error instanceof GoalValidationError) {
      sendError(res, 400, error.message)
      return
    }
    logger.error('[Goals] Failed to update goal:', error)
    sendError(res, 500, 'Failed to update savings goal')
  }
}

/**
 * POST /api/v1/goals/:id/reassign (and /api/v1/portfolio/goals/:id/reassign)
 *
 * Manually move attributed capital from `:id` (`fromGoalId`) to `toGoalId`.
 * Owner-scoped: both goals must belong to the authenticated caller (#358).
 */
export async function reassignGoalHandler(
  req: Request,
  res: Response
): Promise<void> {
  const authUserId = req.auth?.userId ?? req.userId
  if (!authUserId) {
    sendUnauthorized(res)
    return
  }

  const fromGoalId = String(req.params.id)
  const { toGoalId, amount } = req.body as { toGoalId: string; amount: number }

  try {
    const result = await reassignGoalAllocation({
      userId: authUserId,
      fromGoalId,
      toGoalId,
      amount: Number(amount),
    })
    res.status(200).json(result)
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      sendNotFound(res, error.message || 'Savings goal')
      return
    }
    if (error instanceof GoalValidationError) {
      sendError(res, 400, error.message)
      return
    }
    logger.error('[Goals] Failed to reassign goal allocation:', error)
    sendError(res, 500, 'Failed to reassign savings goal allocation')
  }
}

/**
 * DELETE /api/portfolio/goals/:id
 *
 * Soft-cancel: sets status = CANCELLED, never hard-deletes. Ownership is
 * checked explicitly since this route is keyed by goal id.
 */
export async function cancelGoalHandler(
  req: Request,
  res: Response
): Promise<void> {
  const authUserId = req.auth?.userId ?? req.userId
  if (!authUserId) {
    sendUnauthorized(res)
    return
  }

  const id = String(req.params.id)

  try {
    const existing = await getGoalById(id)
    if (!existing) {
      sendNotFound(res, 'Savings goal')
      return
    }
    if (existing.userId !== authUserId) {
      sendUnauthorized(res)
      return
    }

    const goal = await cancelGoal(id)
    res.status(200).json({ goal: mapGoalToResponse(goal) })
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      sendNotFound(res, 'Savings goal')
      return
    }
    logger.error('[Goals] Failed to cancel goal:', error)
    sendError(res, 500, 'Failed to cancel savings goal')
  }
}

/**
 * GET /api/portfolio/goals/:id/progress
 *
 * Current trajectory: projected completion date, required vs. actual APY, and
 * whether the target is reachable within the user's risk tolerance. Ownership
 * is checked explicitly since this route is keyed by goal id.
 */
export async function getGoalProgressHandler(
  req: Request,
  res: Response
): Promise<void> {
  const authUserId = req.auth?.userId ?? req.userId
  if (!authUserId) {
    sendUnauthorized(res)
    return
  }

  const id = String(req.params.id)

  try {
    const existing = await getGoalById(id)
    if (!existing) {
      sendNotFound(res, 'Savings goal')
      return
    }
    if (existing.userId !== authUserId) {
      sendUnauthorized(res)
      return
    }

    const progress = await computeGoalProgress(id)
    res.status(200).json({
      ...progress,
      whatsappReply: formatGoalProgressReply(progress),
    })
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      sendNotFound(res, 'Savings goal')
      return
    }
    logger.error('[Goals] Failed to compute goal progress:', error)
    sendError(res, 500, 'Failed to compute savings goal progress')
  }
}
