// src/config/redis.ts
// #213 – shared Redis client + typed cache helpers.
//
// The client is lazily connected and optional: if REDIS_URL is not set the
// cache helpers become no-ops (get → null, set/del → resolve) so the app and
// tests run without a Redis instance. Callers must therefore treat a null
// getResult as a cache miss and fall back to the source of truth.
import Redis from 'ioredis'
import { logger } from '../utils/logger'

let client: Redis | null = null
let initialized = false

function getClient(): Redis | null {
  if (initialized) return client
  initialized = true

  const url = process.env.REDIS_URL
  if (!url) {
    logger.warn(
      '[redis] REDIS_URL not set — cache disabled, operating in no-op mode'
    )
    client = null
    return null
  }

  client = new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    enableOfflineQueue: false,
  })

  client.on('error', (err) => {
    logger.error('[redis] client error', {
      error: err instanceof Error ? err.message : String(err),
    })
  })

  return client
}

/** Fetch and JSON-parse a cached value. Returns null on miss, disabled cache, or error. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const c = getClient()
  if (!c) return null
  try {
    const raw = await c.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch (err) {
    logger.warn('[redis] cacheGet failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** JSON-serialize and store a value with a TTL in seconds. No-op when cache is disabled. */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const c = getClient()
  if (!c) return
  try {
    await c.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch (err) {
    logger.warn('[redis] cacheSet failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Delete a cached key. No-op when cache is disabled. */
export async function cacheDel(key: string): Promise<void> {
  const c = getClient()
  if (!c) return
  try {
    await c.del(key)
  } catch (err) {
    logger.warn('[redis] cacheDel failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
