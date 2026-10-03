/**
 * Rate limiter identity tiering and blocked-request metrics (#473).
 *
 * The behaviours pinned here were all wrong before:
 *   - every limiter keyed on IP, so a whole office shared one budget and one
 *     abusive key could rotate IPs to escape
 *   - anonymous and authenticated callers drew on the same quota
 *   - `RateLimit-Policy` advertised the configured max even when the effective
 *     limit was a per-API-key override, so clients mis-scheduled their retries
 *   - blocked-request metrics carried no principal type, making a 429 storm
 *     indistinguishable from a broken client
 */

const mockRecordRateLimitHit = jest.fn()
const mockUpdateRateLimitViolations = jest.fn()
const mockUserApiKeyFindFirst = jest.fn()

jest.mock('../../src/utils/metrics', () => ({
  recordRateLimitHit: (...args: unknown[]) => mockRecordRateLimitHit(...args),
  updateRateLimitViolations: (...args: unknown[]) =>
    mockUpdateRateLimitViolations(...args),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    userApiKey: {
      findFirst: (...args: unknown[]) => mockUserApiKeyFindFirst(...args),
    },
  },
}))

jest.mock('../../src/config/env', () => ({
  config: {
    security: {
      rateLimit: { windowMs: 900000, max: 100 },
      authRateLimit: { windowMs: 900000, max: 20 },
      adminRateLimit: { windowMs: 900000, max: 10 },
      webhookRateLimit: { windowMs: 60000, max: 30 },
      internalRateLimit: { windowMs: 60000, max: 500 },
      optimizerRateLimit: { windowMs: 60000, max: 5 },
      simulateRateLimit: { windowMs: 60000, max: 6 },
      anonymousRateLimit: { windowMs: 900000, max: 3 },
      authenticatedRateLimit: { windowMs: 900000, max: 5 },
      sensitiveRateLimit: { windowMs: 900000, max: 2 },
      recoveryRateLimit: { windowMs: 900000, max: 10 },
      trustedIps: [],
      internalServiceToken: '',
    },
  },
}))

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import request from 'supertest'
import {
  buildRateLimiter,
  resolvePrincipal,
  tieredRateLimiter,
} from '../../src/middleware/rateLimiter'

/** Minimal request stand-in for resolvePrincipal(). */
function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '203.0.113.10',
    header: () => undefined,
    ...overrides,
  } as unknown as Request
}

function appWith(
  middleware: ReturnType<typeof buildRateLimiter>,
  resolveUserId?: string
) {
  const app = express()
  // Stands in for requireAuth: the tiered limiter classifies a Bearer token as a
  // user only once req.userId is set, so resolve it before limiting.
  if (resolveUserId) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.userId = resolveUserId
      next()
    })
  }
  app.use(middleware)
  app.get('/api/v1/portfolio', (_req, res) =>
    res.status(200).json({ ok: true })
  )
  return app
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUserApiKeyFindFirst.mockResolvedValue(null)
})

describe('resolvePrincipal', () => {
  it('falls back to the client IP when nothing identifies the caller', () => {
    const principal = resolvePrincipal(fakeRequest())
    expect(principal).toEqual({ type: 'anonymous', key: 'ip:203.0.113.10' })
  })

  it('scopes anonymous buckets to the IP', () => {
    expect(resolvePrincipal(fakeRequest({ ip: '198.51.100.7' })).key).toBe(
      'ip:198.51.100.7'
    )
  })

  it('recognises a verified session as a user', () => {
    const principal = resolvePrincipal(
      fakeRequest({
        userId: 'user-42',
        header: ((name: string) =>
          name === 'Authorization' ? 'Bearer some-jwt' : undefined) as never,
      })
    )
    expect(principal).toEqual({ type: 'user', key: 'user:user-42' })
  })

  it('ignores a Bearer token that no session has verified', () => {
    // Crucially anonymous: trusting the header's presence would let an attacker
    // mint unlimited buckets by sending garbage bearer tokens.
    const principal = resolvePrincipal(
      fakeRequest({
        header: ((name: string) =>
          name === 'Authorization' ? 'Bearer garbage' : undefined) as never,
      })
    )
    expect(principal.type).toBe('anonymous')
  })

  it('keys API keys by key id, not by the full secret', () => {
    const principal = resolvePrincipal(
      fakeRequest({
        header: ((name: string) =>
          name === 'Authorization'
            ? 'Bearer nwk_key-1_secretpart'
            : undefined) as never,
      })
    )
    expect(principal).toEqual({ type: 'api_key', key: 'api_key:key-1' })
  })

  it('never leaks the API key secret into the bucket key', () => {
    const principal = resolvePrincipal(
      fakeRequest({
        header: ((name: string) =>
          name === 'Authorization'
            ? 'Bearer nwk_key-1_supersecret'
            : undefined) as never,
      })
    )
    expect(principal.key).not.toContain('supersecret')
  })

  it('recognises the internal service token', () => {
    process.env.X_TEST = undefined
    const previous = process.env.INTERNAL_SERVICE_TOKEN
    process.env.INTERNAL_SERVICE_TOKEN = 'svc-token'
    const principal = resolvePrincipal(
      fakeRequest({
        res: { locals: { trusted: true } } as never,
        header: ((name: string) =>
          name === 'X-Internal-Token' ? 'svc-token' : undefined) as never,
      })
    )
    expect(principal.type).toBe('internal')
    process.env.INTERNAL_SERVICE_TOKEN = previous
  })

  it('recognises the admin API token', () => {
    const previous = process.env.ADMIN_API_TOKEN
    process.env.ADMIN_API_TOKEN = 'admin-token'
    const principal = resolvePrincipal(
      fakeRequest({
        header: ((name: string) =>
          name === 'X-Admin-Token' ? 'admin-token' : undefined) as never,
      })
    )
    expect(principal).toEqual({ type: 'admin', key: 'admin:token' })
    process.env.ADMIN_API_TOKEN = previous
  })

  it('does not treat a wrong admin token as admin', () => {
    const previous = process.env.ADMIN_API_TOKEN
    process.env.ADMIN_API_TOKEN = 'admin-token'
    const principal = resolvePrincipal(
      fakeRequest({
        header: ((name: string) =>
          name === 'X-Admin-Token' ? 'wrong' : undefined) as never,
      })
    )
    expect(principal.type).toBe('anonymous')
    process.env.ADMIN_API_TOKEN = previous
  })
})

describe('tieredRateLimiter', () => {
  it('gives an anonymous caller the strict anonymous quota', async () => {
    const app = appWith(tieredRateLimiter)
    const res = await request(app).get('/api/v1/portfolio')

    // mocked anonymousRateLimit.max = 3
    expect(res.headers['ratelimit-limit']).toBe('3')
  })

  it('gives an authenticated caller the larger authenticated quota', async () => {
    const app = appWith(tieredRateLimiter, 'user-1')
    const res = await request(app)
      .get('/api/v1/portfolio')
      .set('Authorization', 'Bearer session-jwt')

    // mocked authenticatedRateLimit.max = 5
    expect(res.headers['ratelimit-limit']).toBe('5')
  })

  it('blocks an anonymous caller once the anonymous quota is spent', async () => {
    const app = appWith(tieredRateLimiter)
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/v1/portfolio')
    }

    const res = await request(app).get('/api/v1/portfolio')

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })

  it('keeps separate budgets for two authenticated users behind one IP', async () => {
    // The old IP-only keying made these two share a single bucket.
    const appA = appWith(tieredRateLimiter, 'user-A')
    const appB = appWith(tieredRateLimiter, 'user-B')

    for (let i = 0; i < 5; i++) {
      await request(appA)
        .get('/api/v1/portfolio')
        .set('Authorization', 'Bearer jwt-a')
    }
    const resA = await request(appA)
      .get('/api/v1/portfolio')
      .set('Authorization', 'Bearer jwt-a')
    const resB = await request(appB)
      .get('/api/v1/portfolio')
      .set('Authorization', 'Bearer jwt-b')

    expect(resA.status).toBe(429)
    expect(resB.status).toBe(200)
  })

  it('keeps separate budgets for two API keys behind one IP', async () => {
    const app = appWith(tieredRateLimiter)
    for (let i = 0; i < 5; i++) {
      await request(app)
        .get('/api/v1/portfolio')
        .set('Authorization', 'Bearer nwk_keyA_secretA')
    }
    const a = await request(app)
      .get('/api/v1/portfolio')
      .set('Authorization', 'Bearer nwk_keyA_secretA')
    const b = await request(app)
      .get('/api/v1/portfolio')
      .set('Authorization', 'Bearer nwk_keyB_secretB')

    expect(a.status).toBe(429)
    expect(b.status).toBe(200)
  })

  it('honours a per-API-key rate limit and reports it in the policy header', async () => {
    mockUserApiKeyFindFirst.mockResolvedValue({ rateLimitPerMin: 1 })
    const app = appWith(tieredRateLimiter)
    // The limiter's in-memory store lives for the whole module instance, so a
    // fresh key id is needed here: keyA's bucket was already spent above.
    const token = 'Bearer nwk_keyC_secretC'

    const first = await request(app)
      .get('/api/v1/portfolio')
      .set('Authorization', token)
    const second = await request(app)
      .get('/api/v1/portfolio')
      .set('Authorization', token)

    // The header must state the limit actually applied, not the tier default.
    expect(first.headers['ratelimit-policy']).toBe('1;w=900')
    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
  })

  it('records a blocked request with its principal type', async () => {
    const app = appWith(tieredRateLimiter)
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/v1/portfolio')
    }
    await request(app).get('/api/v1/portfolio')

    expect(mockRecordRateLimitHit).toHaveBeenCalledWith(
      'portfolio',
      'tiered',
      'anonymous'
    )
  })

  it('records a blocked API-key request as api_key, not anonymous', async () => {
    const app = appWith(tieredRateLimiter)
    for (let i = 0; i < 3; i++) {
      await request(app)
        .get('/api/v1/portfolio')
        .set('Authorization', 'Bearer nwk_keyA_secretA')
    }
    await request(app)
      .get('/api/v1/portfolio')
      .set('Authorization', 'Bearer nwk_keyA_secretA')

    const lastCall = mockRecordRateLimitHit.mock.calls.at(-1)
    expect(lastCall?.[2]).toBe('api_key')
  })

  it('raises the active-violation gauge when a request is blocked', async () => {
    const app = appWith(tieredRateLimiter)
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/v1/portfolio')
    }
    await request(app).get('/api/v1/portfolio')

    expect(mockUpdateRateLimitViolations).toHaveBeenCalledWith('portfolio', 1)
  })
})

describe('route grouping', () => {
  it('labels versioned routes without the version segment', async () => {
    const limiter = buildRateLimiter({
      windowMs: 900000,
      max: 1,
      limiterType: 'test',
    })
    const app = appWith(limiter)
    await request(app).get('/api/v1/portfolio')
    await request(app).get('/api/v1/portfolio')

    // The old regex captured "v1" as the route group, so every versioned route
    // collapsed into one indistinguishable metric label.
    expect(mockRecordRateLimitHit).toHaveBeenCalledWith(
      'portfolio',
      'test',
      'anonymous'
    )
  })
})
