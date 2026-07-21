// src/controllers/goal-controller.ts
// Goal-based investing (#281): create/read/update/cancel a savings goal and
// report its progress.
import { Request, Response } from 'express'
import { logger } from '../utils/logger'
import { sendError, sendNotFound, sendUnauthorized, sendConflict } from '../utils/errors'
import { mapGoalToResponse } from '../utils/api-formatters'
import { formatGoalProgressReply } from '../whatsapp/formatters'
import {
  createGoal,
  getGoalForUser,
  getGoalById,
  updateGoal,
  cancelGoal,
  computeGoalProgress,
  GoalConflictError,
  GoalNotFoundError,
  GoalValidationError,
} from '../goals/service'

/**
 * POST /api/portfolio/goals
 *
 * Create the caller's savings goal. Rejects if the caller already has an
 * ACTIVE goal (single active goal per user, for now).
 */
export async function createGoalHandler(req: Request, res: Response): Promise<void> {
  const userId = req.userId
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
 * The user's current goal: their ACTIVE goal if one exists, otherwise their
 * most recent goal. enforceUserAccess guarantees req.auth.userId === :userId.
 */
export async function getGoalHandler(req: Request, res: Response): Promise<void> {
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
 * PATCH /api/portfolio/goals/:id
 *
 * Update target amount/date/riskCeiling. Keyed by goal id (not :userId), so
 * enforceUserAccess doesn't apply — ownership is checked explicitly here.
 */
export async function updateGoalHandler(req: Request, res: Response): Promise<void> {
  const authUserId = req.auth?.userId
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
 * DELETE /api/portfolio/goals/:id
 *
 * Soft-cancel: sets status = CANCELLED, never hard-deletes. Ownership is
 * checked explicitly since this route is keyed by goal id.
 */
export async function cancelGoalHandler(req: Request, res: Response): Promise<void> {
  const authUserId = req.auth?.userId
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
export async function getGoalProgressHandler(req: Request, res: Response): Promise<void> {
  const authUserId = req.auth?.userId
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
