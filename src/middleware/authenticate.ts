import { NextFunction, Request, Response } from 'express'
import { JwtAdapter } from '../config'
import db from '../db'
import { logger } from '../utils/logger'

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_ERRORS = {
  UNAUTHORIZED: 'Unauthorized',
  INVALID_BEARER: 'Invalid Bearer token',
  INVALID_TOKEN: 'Invalid token',
  SESSION_NOT_FOUND: 'Session not found',
  SESSION_EXPIRED: 'Session expired',
  USER_INACTIVE: 'User account is inactive',
  INTERNAL_ERROR: 'Internal server error',
} as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  if (!authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim() // 'Bearer '.length === 7
  return token.length > 0 ? token : null
}

function isExpired(date: Date): boolean {
  return date < new Date()
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Canonical authentication middleware.
 *
 * Validates in order:
 *   1. Bearer token is present and well-formed
 *   2. JWT signature is valid (via JwtAdapter)
 *   3. Session exists in the database (prevents reuse after logout)
 *   4. Session has not expired (stale row is cleaned up automatically)
 *   5. User account is active
 *
 * On success sets req.userId, req.stellarPubKey, and req.auth, then calls next().
 * On failure returns 401 (or 500 for unexpected errors).
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.header('Authorization')

  // 1. Header presence
  if (!authHeader) {
    res.status(401).json({ error: AUTH_ERRORS.UNAUTHORIZED })
    return
  }

  // 2. Bearer format
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: AUTH_ERRORS.INVALID_BEARER })
    return
  }

  const token = extractBearerToken(authHeader)
  if (!token) {
    res.status(401).json({ error: AUTH_ERRORS.INVALID_TOKEN })
    return
  }

  try {
    // 3. JWT signature verification
    const payload = await JwtAdapter.validateToken<{ id: string }>(token)
    if (!payload) {
      res.status(401).json({ error: AUTH_ERRORS.INVALID_TOKEN })
      return
    }

    // 4. Live session lookup
    const session = await db.session.findUnique({
      where: { token },
      include: { user: { select: { id: true, isActive: true } } },
    })

    if (!session) {
      res.status(401).json({ error: AUTH_ERRORS.SESSION_NOT_FOUND })
      return
    }

    // 5. Expiry check — delete stale row in the background, don't await
    if (isExpired(session.expiresAt)) {
      db.session
        .delete({ where: { token } })
        .catch((err) =>
          logger.error('[Auth] Failed to delete expired session:', err)
        )
      res.status(401).json({ error: AUTH_ERRORS.SESSION_EXPIRED })
      return
    }

    // 6. Active user check
    if (!session.user.isActive) {
      res.status(401).json({ error: AUTH_ERRORS.USER_INACTIVE })
      return
    }

    // 7. Attach identity to request
    req.userId = session.user.id
    req.stellarPubKey = session.walletAddress
    req.auth = {
      userId: session.userId,
      sessionId: session.id,
      walletAddress: session.walletAddress,
      network: session.network,
    }

    next()
  } catch (error) {
    logger.error('[Auth] Middleware error:', error)
    res.status(500).json({ error: AUTH_ERRORS.INTERNAL_ERROR })
  }
}

/**
 * Authorization guard: ensures the authenticated user only accesses their own data.
 *
 * Must be placed AFTER requireAuth in the middleware chain.
 * Reads the target userId from req.params.userId or req.body.userId.
 * If neither is present the check is skipped (route doesn't scope to a user).
 */
export function enforceUserAccess(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth) {
    res.status(401).json({ error: AUTH_ERRORS.UNAUTHORIZED })
    return
  }

  const targetUserId = req.params.userId ?? req.body?.userId

  if (targetUserId && req.auth.userId !== targetUserId) {
    res.status(401).json({ error: AUTH_ERRORS.UNAUTHORIZED })
    return
  }

  next()
}

/**
 * Backward-compatibility shim for routes still using AuthMiddleware.validateJwt.
 *
 * @deprecated Import and use `requireAuth` directly.
 * @example
 *   // before
 *   router.get('/', AuthMiddleware.validateJwt, handler)
 *   // after
 *   router.get('/', requireAuth, handler)
 */
export class AuthMiddleware {
  /** @deprecated Use `requireAuth` directly */
  static readonly validateJwt = requireAuth
}
