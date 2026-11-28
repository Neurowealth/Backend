/**
 * requireFreshSignature middleware (#abf9a99, #818).
 *
 * Validates that the request body carries a fresh Stellar wallet-signature
 * challenge (proof-of-control). Used for security-downgrade operations such as
 * disabling TOTP 2FA, where merely having an active session is insufficient:
 * the session itself could be the compromised asset.
 *
 * Expected body shape: { stellarPubKey, nonce, signature }
 *
 * Enforces server-side nonce lifecycle:
 * - Nonce must have been issued by the server and exist in authNonce
 * - Nonce must not be expired
 * - Nonce must be purpose-bound (if purpose is specified)
 * - Cryptographic signature must be valid for the public key and nonce
 * - Nonce is atomically consumed on use to prevent replay attacks (#818)
 */

import { Request, Response, NextFunction, RequestHandler } from 'express'
import { z } from 'zod'
import { verifyAndConsumeStepUpChallenge } from '../controllers/auth-controller'

const freshSignatureSchema = z.object({
  stellarPubKey: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
})

/**
 * Middleware factory: call as `requireFreshSignature(purpose?)` in route definitions.
 * Returns 400 if the body is missing required proof-of-control fields.
 * Returns 401 if the nonce is invalid, expired, replayed, or signature is invalid.
 */
export function requireFreshSignature(purpose?: string): RequestHandler {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const result = freshSignatureSchema.safeParse(req.body)
    if (!result.success) {
      res.status(400).json({
        error: 'Step-up authentication fields missing',
        details: result.error.flatten().fieldErrors,
      })
      return
    }

    const { stellarPubKey, nonce, signature } = req.body

    const isValid = await verifyAndConsumeStepUpChallenge(
      stellarPubKey,
      nonce,
      signature,
      purpose
    )

    if (!isValid) {
      res.status(401).json({ error: 'Step-up authentication failed' })
      return
    }

    res.locals.stepUp = { stellarPubKey, nonce, verified: true }
    next()
  }
}
