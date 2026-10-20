/**
 * #635 — rate-limit counters must be shared across replicas.
 *
 * Two express apps stand in for two pods. Each gets its own store instance
 * (each pod has its own memory) but both talk to one Redis. A client that
 * exhausts the budget on pod A must be throttled on pod B, and the
 * RateLimit and Retry-After headers must reflect the shared counter.
 */
import express from 'express'
import request from 'supertest'
import rateLimit from 'express-rate-limit'
import { RedisRateLimitStore } from '../../../src/middleware/rateLimitStore'

/** Minimal ioredis surface the store uses, backed by one shared Map. */
function createFakeRedis() {
  const data = new Map<string, { value: number; expiresAt: number | null }>()
  const now = () => Date.now()

  function entry(key: string) {
    const row = data.get(key)
    if (!row) return null
    if (row.expiresAt !== null && row.expiresAt <= now()) {
      data.delete(key)
      return null
    }
    return row
  }

  return {
    async incr(key: string) {
      const row = entry(key) ?? { value: 0, expiresAt: null }
      row.value += 1
      data.set(key, row)
      return row.value
    },
    async pttl(key: string) {
      const row = entry(key)
      if (!row) return -2
      if (row.expiresAt === null) return -1
      return row.expiresAt - now()
    },
    async pexpire(key: string, ms: number) {
      const row = entry(key)
      if (!row) return 0
      row.expiresAt = now() + ms
      data.set(key, row)
      return 1
    },
    async del(key: string) {
      return data.delete(key) ? 1 : 0
    },
  }
}

function buildApp(store: RedisRateLimitStore, windowMs: number, max: number) {
  const app = express()
  app.use(
    rateLimit({
      windowMs,
      max,
      store,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests.' },
    })
  )
  app.get('/test', (_req, res) => res.status(200).json({ ok: true }))
  return app
}

describe('RedisRateLimitStore (#635)', () => {
  it('enforces one global budget across two app instances against one Redis', async () => {
    const redis = createFakeRedis()
    // Two "pods": separate store objects, one Redis.
    const podA = new RedisRateLimitStore('rl:test:', redis as never)
    const podB = new RedisRateLimitStore('rl:test:', redis as never)

    const appA = buildApp(podA, 60_000, 5)
    const appB = buildApp(podB, 60_000, 5)

    // Exhaust the budget on pod A: 5 x 200.
    for (let i = 0; i < 5; i++) {
      const res = await request(appA).get('/test')
      expect(res.status).toBe(200)
    }

    // The 6th request on pod A is throttled.
    const blockedA = await request(appA).get('/test')
    expect(blockedA.status).toBe(429)

    // pod B shares the counter — it must also throttle immediately.
    const blockedB = await request(appB).get('/test')
    expect(blockedB.status).toBe(429)

    // Headers derive from the shared counter.
    expect(blockedB.headers['ratelimit-limit']).toBeDefined()
    expect(blockedB.headers['ratelimit-remaining']).toBe('0')
    expect(blockedB.headers['retry-after']).toBeDefined()
    expect(Number(blockedB.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('decrements the shared remaining count on every response', async () => {
    const redis = createFakeRedis()
    const podA = new RedisRateLimitStore('rl:hdr:', redis as never)
    const podB = new RedisRateLimitStore('rl:hdr:', redis as never)

    const appA = buildApp(podA, 60_000, 10)
    const appB = buildApp(podB, 60_000, 10)

    const first = await request(appA).get('/test')
    expect(first.headers['ratelimit-remaining']).toBe('9')

    const second = await request(appB).get('/test')
    expect(second.headers['ratelimit-remaining']).toBe('8')
  })

  it('keeps counters separate per limiter prefix', async () => {
    const redis = createFakeRedis()
    const auth = new RedisRateLimitStore('rl:auth:', redis as never)
    const admin = new RedisRateLimitStore('rl:admin:', redis as never)

    const authApp = buildApp(auth, 60_000, 1)
    const adminApp = buildApp(admin, 60_000, 1)

    expect((await request(authApp).get('/test')).status).toBe(200)
    expect((await request(authApp).get('/test')).status).toBe(429)
    // A different limiter type has its own bucket.
    expect((await request(adminApp).get('/test')).status).toBe(200)
  })
})
