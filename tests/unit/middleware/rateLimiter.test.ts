import express from 'express'
import request from 'supertest'

// Reset modules between tests so env changes take effect
describe('Rate Limiter middleware (unit)', () => {
  // Helper: build a minimal Express app with given limiters on a test route
  function buildApp(middlewares: express.RequestHandler[]) {
    const app = express()
    app.set('trust proxy', 1)
    app.get('/test', ...middlewares, (_req: express.Request, res: express.Response) => {
      res.json({ ok: true })
    })
    return app
  }

  describe('trustedIpBypass', () => {
    beforeEach(() => {
      jest.resetModules()
    })

    it('allows a trusted IP to bypass rate limiting (no 429 even when limit is 0)', async () => {
      process.env.TRUSTED_IPS = '127.0.0.1'
      process.env.RATE_LIMIT_MAX = '0' // Would normally always 429

      // Re-import after env is set
      const { rateLimiter, trustedIpBypass } = await import('../../../src/middleware/rateLimiter')
      const app = buildApp([trustedIpBypass, rateLimiter])

      const res = await request(app).get('/test').set('X-Forwarded-For', '127.0.0.1')
      expect(res.status).toBe(200)

      delete process.env.TRUSTED_IPS
      delete process.env.RATE_LIMIT_MAX
    })

    it('blocks an untrusted IP when rate limit is exceeded', async () => {
      process.env.TRUSTED_IPS = ''
      process.env.RATE_LIMIT_MAX = '0' // Immediately exhausted

      const { rateLimiter, trustedIpBypass } = await import('../../../src/middleware/rateLimiter')
      const app = buildApp([trustedIpBypass, rateLimiter])

      const res = await request(app).get('/test').set('X-Forwarded-For', '10.0.0.1')
      expect(res.status).toBe(429)

      delete process.env.TRUSTED_IPS
      delete process.env.RATE_LIMIT_MAX
    })

    it('allows a request carrying the correct X-Internal-Token header to bypass', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = 'super-secret-token'
      process.env.RATE_LIMIT_MAX = '0'

      const { rateLimiter, trustedIpBypass } = await import('../../../src/middleware/rateLimiter')
      const app = buildApp([trustedIpBypass, rateLimiter])

      const res = await request(app)
        .get('/test')
        .set('X-Internal-Token', 'super-secret-token')
      expect(res.status).toBe(200)

      delete process.env.INTERNAL_SERVICE_TOKEN
      delete process.env.RATE_LIMIT_MAX
    })

    it('blocks a request with a wrong X-Internal-Token header', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = 'super-secret-token'
      process.env.RATE_LIMIT_MAX = '0'

      const { rateLimiter, trustedIpBypass } = await import('../../../src/middleware/rateLimiter')
      const app = buildApp([trustedIpBypass, rateLimiter])

      const res = await request(app)
        .get('/test')
        .set('X-Internal-Token', 'wrong-token')
      expect(res.status).toBe(429)

      delete process.env.INTERNAL_SERVICE_TOKEN
      delete process.env.RATE_LIMIT_MAX
    })
  })

  describe('per-route limiter strictness', () => {
    beforeEach(() => {
      jest.resetModules()
      // Reset env to safe defaults
      process.env.TRUSTED_IPS = ''
      process.env.INTERNAL_SERVICE_TOKEN = ''
    })

    afterEach(() => {
      delete process.env.AUTH_RATE_LIMIT_MAX
      delete process.env.ADMIN_RATE_LIMIT_MAX
      delete process.env.RATE_LIMIT_MAX
    })

    it('authRateLimiter allows fewer requests than the global rateLimiter', async () => {
      process.env.RATE_LIMIT_MAX = '10'
      process.env.AUTH_RATE_LIMIT_MAX = '2'

      const { rateLimiter, authRateLimiter } = await import('../../../src/middleware/rateLimiter')

      const globalApp = buildApp([rateLimiter])
      const authApp = buildApp([authRateLimiter])

      // 3rd request to global should still be OK
      await request(globalApp).get('/test')
      await request(globalApp).get('/test')
      const globalThird = await request(globalApp).get('/test')
      expect(globalThird.status).toBe(200)

      // 3rd request to auth-protected route should be rate-limited
      await request(authApp).get('/test')
      await request(authApp).get('/test')
      const authThird = await request(authApp).get('/test')
      expect(authThird.status).toBe(429)
    })

    it('adminRateLimiter is stricter than authRateLimiter', async () => {
      process.env.AUTH_RATE_LIMIT_MAX = '5'
      process.env.ADMIN_RATE_LIMIT_MAX = '1'

      const { authRateLimiter, adminRateLimiter } = await import('../../../src/middleware/rateLimiter')

      const authApp = buildApp([authRateLimiter])
      const adminApp = buildApp([adminRateLimiter])

      // 2nd auth request should still succeed
      await request(authApp).get('/test')
      const authSecond = await request(authApp).get('/test')
      expect(authSecond.status).toBe(200)

      // 2nd admin request should be blocked
      await request(adminApp).get('/test')
      const adminSecond = await request(adminApp).get('/test')
      expect(adminSecond.status).toBe(429)
    })
  })
})
