/**
 * Shared (cross-replica) hit counter for express-rate-limit (#635).
 *
 * The default MemoryStore counts per process, so n replicas behind a load
 * balancer enforce n x the documented budget. This store keeps the counter in
 * the same Redis the cache/event-bridge already use, so every replica draws
 * on one number. NODE_ENV=test keeps the in-process store: unit tests assert
 * header behaviour and must not need Redis.
 */
import type {
  ClientRateLimitInfo,
  IncrementResponse,
  Options,
  Store,
} from 'express-rate-limit'
import { getRedisClient } from '../config/redis'
import { logger } from '../utils/logger'

type RedisLike = {
  incr(key: string): Promise<number>
  pttl(key: string): Promise<number>
  pexpire(key: string, ms: number): Promise<number>
  del(key: string): Promise<number>
}

export class RedisRateLimitStore implements Store {
  prefix: string
  localKeys = false

  private windowMs = 60_000
  private readonly clientOverride?: RedisLike

  constructor(prefix = 'rl:', clientOverride?: RedisLike) {
    this.prefix = prefix
    this.clientOverride = clientOverride
  }

  init(options: Options): void {
    this.windowMs = options.windowMs
  }

  private client(): RedisLike | null {
    return (this.clientOverride ?? getRedisClient()) as RedisLike | null
  }

  async increment(key: string): Promise<IncrementResponse> {
    const client = this.client()
    if (!client) {
      throw new Error('Redis unavailable for rate-limit store')
    }
    const redisKey = this.prefix + key
    const totalHits = await client.incr(redisKey)
    if (totalHits === 1) {
      await client.pexpire(redisKey, this.windowMs)
    }
    const pttl = await client.pttl(redisKey)
    return {
      totalHits,
      resetTime: new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs)),
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const client = this.client()
    if (!client) return undefined
    const redisKey = this.prefix + key
    const pttl = await client.pttl(redisKey)
    if (pttl < 0) return undefined
    return {
      totalHits: 0,
      resetTime: new Date(Date.now() + pttl),
    }
  }

  async decrement(): Promise<void> {
    // express-rate-limit only calls this to correct double-counting; the
    // increment above is the source of truth and is not rolled back.
  }

  async resetKey(key: string): Promise<void> {
    const client = this.client()
    if (!client) return
    await client.del(this.prefix + key)
  }
}

/**
 * Store used by every limiter. In tests this is left undefined so
 * express-rate-limit falls back to its in-process MemoryStore; everywhere
 * else it is the shared Redis counter. If Redis is not configured the
 * limiter still works, but per-pod — a warning says so.
 */
export function resolveRateLimitStore(limiterType: string): Store | undefined {
  if (process.env.NODE_ENV === 'test') return undefined
  if (!getRedisClient()) {
    logger.warn(
      '[rate-limit] REDIS_URL not set — counters are per-pod; multi-replica deployments will exceed documented limits',
      { limiterType }
    )
    return undefined
  }
  return new RedisRateLimitStore(`rl:${limiterType}:`)
}
