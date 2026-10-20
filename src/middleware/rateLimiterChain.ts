/**
 * The app-wide rate-limit chain (#614).
 *
 * These two limiters are mounted before routing, so they apply to EVERY
 * request the server serves — including requests that match no route at all.
 * Keeping them in one named list (rather than two `app.use` calls inline in
 * src/index.ts) means the tier-matrix CI check can read the chain and
 * assert the claim "every route is covered by the global + tiered budgets"
 * instead of taking it on trust.
 *
 *   global — a flat budget over everything.
 *   tiered — the identity split: strict per-IP for anonymous callers,
 *            generous per-principal for callers that proved an identity.
 */

import {
  rateLimiter,
  tieredRateLimiter,
  type TaggedRateLimiter,
} from './rateLimiter'

/** Mounted in order: the flat budget, then the identity tier. */
export const APP_LEVEL_LIMITERS: TaggedRateLimiter[] = [
  rateLimiter,
  tieredRateLimiter,
]
