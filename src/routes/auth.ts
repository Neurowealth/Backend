import { Router } from 'express';
import { challenge, verify, logout } from '../controllers/auth-controller';
import { AuthMiddleware } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { authChallengeSchema, authVerifySchema } from '../validators/auth-validators';

const router = Router();

/**
 * POST /api/auth/challenge
 * Returns a one-time nonce to be signed by the Stellar keypair.
 */
router.post('/challenge', validate({ body: authChallengeSchema }), challenge);

/**
 * POST /api/auth/verify
 * Verifies Stellar signature, creates/fetches user, issues JWT.
 */
router.post('/verify', validate({ body: authVerifySchema }), verify);

/**
 * POST /api/auth/logout
 * Revokes the active session. Requires a valid Bearer token.
 */
router.post('/logout', AuthMiddleware.validateJwt, logout);

export default router;
