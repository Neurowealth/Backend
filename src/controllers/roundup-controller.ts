import type { Request, Response } from 'express'
import { logger } from '../utils/logger'
import { sendError, sendUnauthorized } from '../utils/errors'
import {
  getRoundUpSettings,
  updateRoundUpSettings,
  getRoundUpAccruals,
  TargetGoalNotFoundError,
} from '../roundup/service'
import { executeUserSweep } from '../jobs/roundUpSweep'

/**
 * Retrieves the round-up savings settings for the authenticated user.
 *
 * @param req - Express request with authenticated userId.
 * @param res - Express response.
 */
export async function getRoundUpSettingsHandler(
  req: Request,
  res: Response
): Promise<Response> {
  const userId = req.userId
  if (!userId) {
    return sendUnauthorized(res)
  }

  try {
    const settings = await getRoundUpSettings(userId)
    return res.status(200).json({ settings })
  } catch (error: any) {
    logger.error('[RoundUp] Failed to retrieve settings', {
      userId,
      error: error?.message,
    })
    return sendError(res, 500, 'Failed to retrieve round-up settings')
  }
}

/**
 * Updates round-up savings settings for the authenticated user.
 *
 * @param req - Express request with update body and authenticated userId.
 * @param res - Express response.
 */
export async function updateRoundUpSettingsHandler(
  req: Request,
  res: Response
): Promise<Response> {
  const userId = req.userId
  if (!userId) {
    return sendUnauthorized(res)
  }

  try {
    const settings = await updateRoundUpSettings(userId, req.body)
    return res.status(200).json({ settings })
  } catch (error: any) {
    if (error instanceof TargetGoalNotFoundError) {
      return sendError(res, 404, error.message)
    }
    logger.error('[RoundUp] Failed to update settings', {
      userId,
      error: error?.message,
    })
    return sendError(res, 500, 'Failed to update round-up settings')
  }
}

/**
 * Retrieves accumulated round-up balance and history for the authenticated user.
 *
 * @param req - Express request with authenticated userId.
 * @param res - Express response.
 */
export async function getRoundUpAccrualsHandler(
  req: Request,
  res: Response
): Promise<Response> {
  const userId = req.userId
  if (!userId) {
    return sendUnauthorized(res)
  }

  try {
    const accruals = await getRoundUpAccruals(userId)
    return res.status(200).json(accruals)
  } catch (error: any) {
    logger.error('[RoundUp] Failed to retrieve accruals', {
      userId,
      error: error?.message,
    })
    return sendError(res, 500, 'Failed to retrieve round-up accruals')
  }
}

/**
 * Triggers an immediate sweep of accumulated round-ups into an on-chain deposit.
 *
 * @param req - Express request with optional force flag and authenticated userId.
 * @param res - Express response.
 */
export async function triggerSweepHandler(
  req: Request,
  res: Response
): Promise<Response> {
  const userId = req.userId
  if (!userId) {
    return sendUnauthorized(res)
  }

  try {
    const force = Boolean(req.body?.force)
    const sweep = await executeUserSweep(userId, force)
    return res.status(200).json({ sweep })
  } catch (error: any) {
    logger.error('[RoundUp] Failed to execute sweep', {
      userId,
      error: error?.message,
    })
    return sendError(res, 500, 'Failed to execute round-up sweep')
  }
}
