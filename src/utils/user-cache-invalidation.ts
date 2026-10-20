import { cacheGet, cacheSet, cacheDel, getRedisClient, createRedisSubscriber } from '../config/redis'
import { logger } from './logger'
import { generateCorrelationId } from './correlation'
import type { Redis } from 'ioredis'

/** Cache key prefixes for user-related state */
export const CACHE_PREFIXES = {
  PORTFOLIO: 'portfolio_snapshot',
  USER_PROFILE: 'user_profile',
  ASSISTANT_MEMORY: 'assistant:memory',
} as const

const CACHE_INVALIDATION_CHANNEL = process.env.CACHE_INVALIDATION_CHANNEL || 'neurowealth:cache-invalidation'

let subscriber: Redis | null = null
let subscribed = false

export interface CacheInvalidationEvent {
  userId: string
  correlationId: string
  timestamp: number
  originPodId: string
}

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
 * Publishes to Redis for cross-pod invalidation.
 */
export async function invalidateAllUserCaches(userId: string): Promise<void> {
  if (!userId) return

  const correlationId = generateCorrelationId()
  const podId = process.env.HOSTNAME || 'unknown'

  await Promise.allSettled([
    invalidatePortfolioCache(userId),
    invalidateUserProfileCache(userId),
    invalidateUserAssistantMemory(userId, 'whatsapp'),
    invalidateUserAssistantMemory(userId, 'telegram'),
    invalidateUserAssistantMemory(userId, 'api'),
    invalidateUserAssistantMemory(userId, 'web'), // Remove legacy keys too.
  ])

  logger.info('[cache] Cleared all cached state for user', { userId })

  const redis = getRedisClient()
  if (redis) {
    try {
      const event: CacheInvalidationEvent = {
        userId,
        correlationId,
        timestamp: Date.now(),
        originPodId: podId,
      }
      await redis.publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify(event))
      logger.debug('[cache] Published cache invalidation event', { userId, podId })
    } catch (error) {
      logger.warn('[cache] Failed to publish cache invalidation event', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
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

/**
 * Start listening for cache invalidation events from other pods.
 * Safe to call multiple times; no-op after first call.
 */
export function startCacheInvalidationSubscriber(): void {
  if (subscribed) return
  subscribed = true

  subscriber = createRedisSubscriber()
  if (!subscriber) {
    logger.warn(
      '[cache] REDIS_URL not set — cross-pod cache invalidation disabled. ' +
        'Single-instance deployments are unaffected; horizontally scaled ones ' +
        'will only invalidate caches on the pod where the mutation occurred.'
    )
    return
  }

  subscriber.on('message', (channel, raw) => {
    if (channel !== CACHE_INVALIDATION_CHANNEL) return

    try {
      const event = JSON.parse(raw) as CacheInvalidationEvent
      if (
        typeof event?.userId !== 'string' ||
        typeof event?.correlationId !== 'string' ||
        typeof event?.timestamp !== 'number' ||
        typeof event?.originPodId !== 'string'
      ) {
        logger.warn('[cache] Discarded invalid cache invalidation event')
        return
      }

      const podId = process.env.HOSTNAME || 'unknown'
      if (event.originPodId === podId) {
        return
      }

      invalidateAllUserCaches(event.userId).catch((error) => {
        logger.warn('[cache] Failed to process cross-pod invalidation', {
          userId: event.userId,
          originPodId: event.originPodId,
          error: error instanceof Error ? error.message : String(error),
        })
      })

      logger.debug('[cache] Processed cross-pod cache invalidation', {
        userId: event.userId,
        originPodId: event.originPodId,
      })
    } catch (error) {
      logger.warn('[cache] Failed to parse cache invalidation event', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  subscriber.subscribe(CACHE_INVALIDATION_CHANNEL).then(() => {
    logger.info(`[cache] Subscribed to ${CACHE_INVALIDATION_CHANNEL}`)
  }).catch((error) => {
    logger.error('[cache] Failed to subscribe to cache invalidation channel', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

/**
 * Close the cache invalidation subscriber. Safe to call when never started.
 */
export async function stopCacheInvalidationSubscriber(): Promise<void> {
  subscribed = false
  if (!subscriber) return
  try {
    await subscriber.unsubscribe(CACHE_INVALIDATION_CHANNEL)
    await subscriber.quit()
  } catch (error) {
    logger.warn('[cache] Subscriber shutdown error', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    subscriber = null
  }
}
