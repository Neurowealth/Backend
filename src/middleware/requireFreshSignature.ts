/**
 * requireFreshSignature middleware (#abf9a99).
 *
 * Validates that the request body carries a fresh Stellar wallet-signature
 * challenge (proof-of-control). Used for security-downgrade operations such as
 * disabling TOTP 2FA, where merely having an active session is insufficient —
 * the session itself could be the compromised asset.
 *
 * Expected body shape: { stellarPubKey, nonce, signature }
 *
 * The actual cryptographic verification is delegated to stellarVerification and
 * the User lookup is left to the route handler that needs the full User record.
 * This middleware only performs structural validation to fail fast.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express'
import { z } from 'zod'

const freshSignatureSchema = z.object({
  stellarPubKey: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
})

/**
 * Middleware factory — call as `requireFreshSignature()` in route definitions.
 * Returns a 400 if the body is missing the required proof-of-control fields.
 */
export function requireFreshSignature(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = freshSignatureSchema.safeParse(req.body)
    if (!result.success) {
      res.status(400).json({
        error: 'Step-up authentication fields missing',
        details: result.error.flatten().fieldErrors,
      })
      return
    }
    next()
  }
}
