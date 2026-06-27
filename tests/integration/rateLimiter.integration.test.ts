import express from 'express'
import request from 'supertest'
import { rateLimiter, buildRateLimiter } from '../../src/middleware/rateLimiter'

jest.mock('../../src/utils/metrics', () => ({
  recordRateLimitHit: jest.fn(),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

jest.mock('../../src/config/env', () => ({
  config: {
    security: {
      rateLimit: { windowMs: 900000, max: 100 },
      authRateLimit: { windowMs: 900000, max: 20 },
      adminRateLimit: { windowMs: 900000, max: 10 },
      webhookRateLimit: { windowMs: 60000, max: 30 },
      internalRateLimit: { windowMs: 60000, max: 500 },
      trustedIps: [],
      internalServiceToken: '',
    },
  },
}))

function buildTestApp(middleware: ReturnType<typeof buildRateLimiter>) {
  const app = express()
  app.use(middleware)
  app.get('/test', (_req, res) => res.status(200).json({ ok: true }))
  return app
}

describe('rate limiter – IETF rate-limit headers', () => {
  describe('normal (non-throttled) responses', () => {
    it('sets RateLimit-Limit, RateLimit-Remaining, and RateLimit-Reset', async () => {
      const app = buildTestApp(rateLimiter)
      const res = await request(app).get('/test')

      expect(res.status).toBe(200)
      expect(res.headers).toHaveProperty('ratelimit-limit')
      expect(res.headers).toHaveProperty('ratelimit-remaining')
      expect(res.headers).toHaveProperty('ratelimit-reset')
    })

    it('sets RateLimit-Policy with correct limit and window', async () => {
      const app = buildTestApp(rateLimiter)
      const res = await request(app).get('/test')

      // global limiter: 100 req / 900 s
      expect(res.headers['ratelimit-policy']).toBe('100;w=900')
    })

    it('reflects the configured limit and window in RateLimit-Policy for custom limiters', async () => {
      const limiter = buildRateLimiter({ windowMs: 60000, max: 30, limiterType: 'test' })
      const app = buildTestApp(limiter)
      const res = await request(app).get('/test')

      expect(res.headers['ratelimit-policy']).toBe('30;w=60')
    })
  })

  describe('throttled (429) responses', () => {
    it('returns 429 after the request budget is exhausted', async () => {
      const limiter = buildRateLimiter({ windowMs: 60000, max: 1, limiterType: 'test' })
      const app = buildTestApp(limiter)

      await request(app).get('/test') // uses up the single allowed request
      const res = await request(app).get('/test')

      expect(res.status).toBe(429)
      expect(res.body.error).toContain('Too many requests')
    })

    it('sets Retry-After (positive integer, seconds) on 429 responses', async () => {
      const limiter = buildRateLimiter({ windowMs: 60000, max: 1, limiterType: 'test' })
      const app = buildTestApp(limiter)

      await request(app).get('/test')
      const res = await request(app).get('/test')

      expect(res.status).toBe(429)
      const retryAfter = Number(res.headers['retry-after'])
      expect(Number.isInteger(retryAfter)).toBe(true)
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(60)
    })

    it('sets RateLimit-Policy on 429 responses', async () => {
      const limiter = buildRateLimiter({ windowMs: 60000, max: 1, limiterType: 'test' })
      const app = buildTestApp(limiter)

      await request(app).get('/test')
      const res = await request(app).get('/test')

      expect(res.status).toBe(429)
      expect(res.headers['ratelimit-policy']).toBe('1;w=60')
    })
  })
})
