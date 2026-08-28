// src/controllers/goal-simulation-controller.ts
// Goal simulation (#319): Monte Carlo goal attainment probability.

import { Request, Response } from 'express'
import { logger } from '../utils/logger'
import { sendError, sendNotFound, sendUnauthorized } from '../utils/errors'
import {
  simulateGoal,
  GoalNotFoundError,
  GoalValidationError,
  InsufficientHistoryError,
} from '../goals/simulation'

/**
 * POST /api/v1/goals/:id/simulate
 *
 * Monte Carlo simulation for a savings goal's attainment probability.
 * Owner-scoped: the caller must own the goal.
 *
 * Returns:
 * - attainmentProbability (fraction of paths that crossed the target)
 * - median and 5/95 percentile projected balances
 * - required-rate sensitivity table
 * - isSimulation: true disclaimer
 *
 * Validation:
 * - target date must be in the future (enforced in simulateGoal)
 * - insufficient_history returns an explicit outcome, not a guessed probability
 */
export async function simulateGoalHandler(
  req: Request,
  res: Response
): Promise<void> {
  const authUserId = req.auth?.userId
  if (!authUserId) {
    sendUnauthorized(res)
    return
  }

  const id = String(req.params.id)

  try {
    const result = await simulateGoal(id, authUserId, {
      iterations: req.body?.iterations,
      seed: req.body?.seed,
      mode: req.body?.mode,
    })

    res.status(200).json(result)
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      sendNotFound(res, 'Savings goal')
      return
    }
    if (error instanceof GoalValidationError) {
      sendError(res, 400, error.message)
      return
    }
    if (error instanceof InsufficientHistoryError) {
      res.status(200).json({
        status: 'insufficient_history',
        earliestAvailableDate:
          error.earliestAvailableDate?.toISOString() ?? null,
        message: error.message,
        isSimulation: true,
      })
      return
    }
    logger.error('[Simulate] Failed to run simulation:', error)
    sendError(res, 500, 'Failed to run goal simulation')
  }
}
