// src/utils/portfolio-cache.ts
// #213 – per-user portfolio snapshot cache helpers.
// Integrates with user-cache-invalidation.ts (#514).

import { cacheSet } from '../config/redis'
import {
  portfolioCacheKey,
  validateOrInvalidateCache,
  invalidatePortfolioCache,
} from './user-cache-invalidation'

const PORTFOLIO_CACHE_TTL = parseInt(
  process.env.PORTFOLIO_CACHE_TTL_SECONDS || '60'
)

export { portfolioCacheKey, invalidatePortfolioCache }

export async function getPortfolioSnapshot<T>(
  userId: string
): Promise<T | null> {
  return validateOrInvalidateCache<T>(
    portfolioCacheKey(userId),
    async () => null,
    {
      version: 1,
      maxAgeMs: PORTFOLIO_CACHE_TTL * 1000,
    },
    PORTFOLIO_CACHE_TTL
  )
}

export async function setPortfolioSnapshot(
  userId: string,
  data: unknown
): Promise<void> {
  await cacheSet(
    portfolioCacheKey(userId),
    { data, cachedAt: Date.now(), version: 1 },
    PORTFOLIO_CACHE_TTL
  )
}

/**
 * Invalidate the portfolio snapshot for a user.
 * Alias for invalidatePortfolioCache(userId) (#514).
 */
export async function invalidatePortfolioSnapshot(
  userId: string
): Promise<void> {
  await invalidatePortfolioCache(userId)
}
