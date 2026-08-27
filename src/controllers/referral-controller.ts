// src/controllers/referral-controller.ts
// Referral rewards program (#growth): the caller's own code + their referrals.
import { Request, Response } from 'express'
import { logger } from '../utils/logger'
import { sendError, sendUnauthorized } from '../utils/errors'
import { getOrCreateReferralCode, listReferrals } from '../referral/service'

/**
 * GET /api/referrals/code
 *
 * Return (creating on first request) the authenticated caller's referral code.
 * Idempotent — the same code is returned on every call.
 */
export async function getMyReferralCode(
  req: Request,
  res: Response
): Promise<void> {
  const userId = req.userId
  if (!userId) {
    sendUnauthorized(res)
    return
  }

  try {
    const { code, createdAt } = await getOrCreateReferralCode(userId)
    res.status(200).json({ code, createdAt: createdAt.toISOString() })
  } catch (error) {
    logger.error('[Referral] Failed to get/create referral code:', error)
    sendError(res, 500, 'Failed to retrieve referral code')
  }
}

/**
 * GET /api/referrals/:userId
 *
 * List the referrals attributed to a user's code, newest first. Owner-scoped:
 * enforceUserAccess guarantees req.auth.userId === :userId before this runs.
 */
export async function getReferrals(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.userId)

  try {
    const result = await listReferrals(userId)
    res.status(200).json(result)
  } catch (error) {
    logger.error('[Referral] Failed to list referrals:', error)
    sendError(res, 500, 'Failed to retrieve referrals')
  }
}
