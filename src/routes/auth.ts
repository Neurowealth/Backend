import { Router } from 'express'
import {
  challenge,
  verify,
  refresh,
  logout,
  verifyTotp,
} from '../controllers/auth-controller'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import {
  authChallengeSchema,
  authVerifySchema,
  authRefreshSchema,
} from '../validators/auth-validators'

const router = Router()

/**
 * POST /api/auth/challenge
 * Returns a one-time nonce to be signed by the Stellar keypair.
 */
router.post('/challenge', validate({ body: authChallengeSchema }), challenge)

/**
 * POST /api/auth/verify
 * Verifies Stellar signature, creates/fetches user, issues JWT.
 */
router.post('/verify', validate({ body: authVerifySchema }), verify)

/**
 * POST /api/auth/2fa/verify
 * Completes a login paused at the TOTP step.
 */
router.post('/2fa/verify', verifyTotp)

/**
 * POST /api/auth/refresh
 * #472: exchanges a refresh token for a new pair. Every success rotates the
 * refresh token, and presenting one that was already exchanged revokes the
 * session. Not behind requireAuth — the caller's access token is the thing that
 * has expired. Rate limited as part of the auth tier.
 */
router.post('/refresh', validate({ body: authRefreshSchema }), refresh)

/**
 * POST /api/auth/logout
 * Revokes the active session. Requires a valid Bearer token.
 */
router.post('/logout', requireAuth, logout)

export default router
