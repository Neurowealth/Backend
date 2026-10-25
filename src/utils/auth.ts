import type { Request } from 'express'

/**
 * Resolves the authenticated user id for a request that has already passed
 * `requireAuth`.
 *
 * `requireAuth` (src/middleware/authenticate.ts) populates `req.auth` and, for
 * backwards compatibility, `req.userId`. Reading `req.auth` is authoritative;
 * `req.userId` is only consulted as a fallback for routes still migrating off
 * the legacy shape. Callers get `null` rather than a cast-through-any so an
 * unauthenticated request can never be attributed to an arbitrary id.
 */
export function getAuthUserId(req: Request): string | null {
  return req.auth?.userId ?? req.userId ?? null
}
