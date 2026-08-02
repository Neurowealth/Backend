/**
 * Referral rewards program routes.
 *
 *   GET /api/referrals/code       — auth; caller's own referral code (created on first call)
 *   GET /api/referrals/:userId    — auth; referrals attributed to that user (owner-scoped)
 *
 * Signup attribution is NOT a route here — it happens on POST /api/auth/verify
 * via an optional `referralCode` field, so attribution is captured atomically
 * with account creation.
 */
import { Router } from 'express'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { referralUserParamsSchema } from '../validators/referral-validators'
import {
  getMyReferralCode,
  getReferrals,
} from '../controllers/referral-controller'

const router = Router()

// The caller's own code. Must precede the /:userId route so "code" is not
// captured as a userId.
router.get('/code', requireAuth, getMyReferralCode)

router.get(
  '/:userId',
  requireAuth,
  validate({ params: referralUserParamsSchema }),
  enforceUserAccess,
  getReferrals
)

export default router
