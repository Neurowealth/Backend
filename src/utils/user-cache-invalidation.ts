import { cacheGet, cacheSet, cacheDel } from '../config/redis'
import { logger } from './logger'

/** Cache key prefixes for user-related state */
export const CACHE_PREFIXES = {
  PORTFOLIO: 'portfolio_snapshot',
  USER_PROFILE: 'user_profile',
  ASSISTANT_MEMORY: 'assistant:memory',
} as const

export interface StaleCheckOptions<T> {
  maxAgeMs?: number
  updatedAt?: Date | string | number
  version?: number
  isValid?: (data: T) => boolean
}

export interface CachedEnvelope<T> {
  data: T
  cachedAt: number
  version?: number
}

/** Construct standard portfolio cache key. */
export function portfolioCacheKey(userId: string): string {
  return `${CACHE_PREFIXES.PORTFOLIO}:${userId}`
}

/** Construct standard user profile cache key. */
export function userProfileCacheKey(userId: string): string {
  return `${CACHE_PREFIXES.USER_PROFILE}:${userId}`
}

/** Construct assistant conversation memory cache key. */
export function assistantMemoryCacheKey(
  channel: string,
  userId: string
): string {
  return `${CACHE_PREFIXES.ASSISTANT_MEMORY}:${channel}:${userId}`
}

/** Invalidate portfolio snapshot cache for a user. */
export async function invalidatePortfolioCache(userId: string): Promise<void> {
  if (!userId) return
  try {
    await cacheDel(portfolioCacheKey(userId))
    logger.debug('[cache] Invalidated portfolio snapshot cache', { userId })
  } catch (err) {
    logger.warn('[cache] Failed to invalidate portfolio cache', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Invalidate cached user profile/settings. */
export async function invalidateUserProfileCache(
  userId: string
): Promise<void> {
  if (!userId) return
  try {
    await cacheDel(userProfileCacheKey(userId))
    logger.debug('[cache] Invalidated user profile cache', { userId })
  } catch (err) {
    logger.warn('[cache] Failed to invalidate user profile cache', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Invalidate assistant conversation memory for a user. */
export async function invalidateUserAssistantMemory(
  userId: string,
  channel = 'whatsapp'
): Promise<void> {
  if (!userId) return
  try {
    await cacheDel(assistantMemoryCacheKey(channel, userId))
    logger.debug('[cache] Invalidated assistant memory', { userId, channel })
  } catch (err) {
    logger.warn('[cache] Failed to invalidate assistant memory', {
      userId,
      channel,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Invalidate ALL cached state for a user.
 * Triggered on logout, session revocation, or user account changes.
 */
export async function invalidateAllUserCaches(userId: string): Promise<void> {
  if (!userId) return
  await Promise.allSettled([
    invalidatePortfolioCache(userId),
    invalidateUserProfileCache(userId),
    invalidateUserAssistantMemory(userId, 'whatsapp'),
    invalidateUserAssistantMemory(userId, 'telegram'),
    invalidateUserAssistantMemory(userId, 'api'),
    invalidateUserAssistantMemory(userId, 'web'), // Remove legacy keys too.
  ])
  logger.info('[cache] Cleared all cached state for user', { userId })
}

/**
 * Fetch from cache with automatic staleness validation.
 * If cached data is missing or stale, fetches fresh data from DB, updates cache, and returns fresh data.
 */
export async function validateOrInvalidateCache<T>(
  key: string,
  fetchFresh: () => Promise<T | null>,
  options: StaleCheckOptions<T> = {},
  ttlSeconds = 60
): Promise<T | null> {
  const startedAt = Date.now()
  let cached: CachedEnvelope<T> | null = null
  try {
    cached = await cacheGet<CachedEnvelope<T>>(key)
  } catch (error) {
    logger.warn('[cache] Read failed; using primary store', { key })
  }
  const maxAgeMs = options.maxAgeMs ?? ttlSeconds * 1000
  const updatedAt =
    options.updatedAt === undefined
      ? undefined
      : new Date(options.updatedAt).getTime()
  let valid =
    cached !== null &&
    typeof cached === 'object' &&
    cached.data !== undefined &&
    cached.data !== null &&
    typeof cached.cachedAt === 'number' &&
    Number.isFinite(cached.cachedAt) &&
    cached.cachedAt > 0 &&
    cached.cachedAt <= startedAt &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs > 0 &&
    startedAt - cached.cachedAt < maxAgeMs &&
    (options.version === undefined || cached.version === options.version) &&
    (updatedAt === undefined ||
      (Number.isFinite(updatedAt) && cached.cachedAt >= updatedAt))
  if (valid && options.isValid) {
    try {
      valid = options.isValid(cached!.data)
    } catch {
      valid = false
    }
  }
  if (valid) return cached!.data

  if (cached !== null) {
    try {
      await cacheDel(key)
    } catch {
      logger.warn('[cache] Eviction failed', { key })
    }
  }
  // Primary-store errors intentionally propagate; a stale value is never a fallback.
  const freshData = await fetchFresh()
  if (freshData !== null && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    try {
      await cacheSet(
        key,
        {
          data: freshData,
          // Age includes fetch duration, not just time since cache write.
          cachedAt: startedAt,
          version: options.version,
        },
        ttlSeconds
      )
    } catch {
      logger.warn('[cache] Write failed; returning primary-store value', {
        key,
      })
    }
  }
  return freshData
}
