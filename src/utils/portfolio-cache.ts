// src/utils/portfolio-cache.ts
// #213 – per-user portfolio snapshot cache helpers.
// Call invalidatePortfolioCache(userId) on every deposit/withdraw mutation.
import { cacheGet, cacheSet, cacheDel } from '../config/redis'

const PORTFOLIO_CACHE_TTL = parseInt(
  process.env.PORTFOLIO_CACHE_TTL_SECONDS || '60'
)

export function portfolioCacheKey(userId: string): string {
  return `portfolio_snapshot:${userId}`
}

export async function getPortfolioSnapshot<T>(
  userId: string
): Promise<T | null> {
  return cacheGet<T>(portfolioCacheKey(userId))
}

export async function setPortfolioSnapshot(
  userId: string,
  data: unknown
): Promise<void> {
  await cacheSet(portfolioCacheKey(userId), data, PORTFOLIO_CACHE_TTL)
}

/**
 * Invalidate the portfolio snapshot for a user.
 * Call this from deposit/withdraw/rebalance mutations so the next
 * request re-computes from DB instead of returning stale data.
 */
export async function invalidatePortfolioSnapshot(
  userId: string
): Promise<void> {
  await cacheDel(portfolioCacheKey(userId))
}
