/**
 * CORS allowlist enforcement (#471).
 *
 * The allowlist is enforced in production *and* staging; only development and
 * test permit arbitrary origins. These tests build a policy per environment with
 * `createCorsMiddleware`, so each environment is exercised in isolation rather
 * than depending on whichever environment the process happens to be running in.
 *
 * The preflight tests matter most: a simple request is never preflighted, so
 * asserting "header X is allowed" on a GET proves nothing about the
 * `allowedHeaders` list. Every header assertion below goes through a real
 * OPTIONS preflight.
 */

import express from 'express'
import request from 'supertest'
import {
  buildOriginPolicy,
  evaluateOrigin,
  normalizeOrigin,
  parseSubdomainPattern,
  type CorsOriginPolicy,
} from '../src/config/cors'
import {
  createCorsMiddleware,
  validateCorsConfig,
} from '../src/middleware/corsandbody'

jest.mock('../src/config/env', () => ({
  config: {
    nodeEnv: 'production',
    security: { bodySizeLimit: '100kb' },
  },
}))

jest.mock('../src/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const PROD_ORIGINS = 'https://app.example.com,https://admin.example.com'

function policyFor(
  raw: string | undefined,
  environment: string
): CorsOriginPolicy {
  return buildOriginPolicy({ raw, environment })
}

function appFor(policy: CorsOriginPolicy): express.Application {
  const app = express()
  app.use(createCorsMiddleware(policy))
  app.get('/test', (_req, res) => res.json({ ok: true }))
  app.post('/test', (_req, res) => res.status(201).json({ created: true }))
  return app
}

/** A genuine browser preflight. */
function preflight(app: express.Application, origin: string, headers: string) {
  return request(app)
    .options('/test')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', headers)
}

describe('origin normalisation', () => {
  it('strips a trailing slash', () => {
    expect(normalizeOrigin('https://app.example.com/')).toBe(
      'https://app.example.com'
    )
  })

  it('lowercases the host', () => {
    expect(normalizeOrigin('https://APP.Example.COM')).toBe(
      'https://app.example.com'
    )
  })

  it('folds the scheme default port away', () => {
    expect(normalizeOrigin('https://app.example.com:443')).toBe(
      'https://app.example.com'
    )
    expect(normalizeOrigin('http://app.example.com:80')).toBe(
      'http://app.example.com'
    )
  })

  it('keeps a non-default port', () => {
    expect(normalizeOrigin('http://localhost:3000')).toBe(
      'http://localhost:3000'
    )
  })

  it('rejects values that are not origins', () => {
    expect(normalizeOrigin('app.example.com')).toBeNull()
    expect(normalizeOrigin('https://app.example.com/path')).toBeNull()
    expect(normalizeOrigin('https://app.example.com?x=1')).toBeNull()
    expect(normalizeOrigin('null')).toBeNull()
    expect(normalizeOrigin('file://')).toBeNull()
    expect(normalizeOrigin('')).toBeNull()
  })
})

describe('subdomain wildcards', () => {
  it('parses a single-label wildcard', () => {
    const pattern = parseSubdomainPattern('https://*.example.com')
    expect(pattern).toMatchObject({ protocol: 'https:', host: 'example.com' })
  })

  it('rejects nested wildcards', () => {
    expect(parseSubdomainPattern('https://*.*.example.com')).toBeNull()
  })

  it('rejects a wildcard that is not the leftmost label', () => {
    expect(parseSubdomainPattern('https://app.*.example.com')).toBeNull()
  })

  it('matches exactly one label', () => {
    const policy = policyFor('https://*.example.com', 'production')
    expect(evaluateOrigin(policy, 'https://staging.example.com').allowed).toBe(
      true
    )
    // Nested subdomains are not covered: a wildcard that reaches arbitrary
    // depth hands an attacker a domain under a name you do not control.
    expect(evaluateOrigin(policy, 'https://a.b.example.com').allowed).toBe(
      false
    )
    // Nor is the apex — that must be listed explicitly.
    expect(evaluateOrigin(policy, 'https://example.com').allowed).toBe(false)
  })
})

describe('production allowlist', () => {
  const policy = policyFor(PROD_ORIGINS, 'production')
  const app = appFor(policy)

  it('enforces the allowlist', () => {
    expect(policy.strict).toBe(true)
    expect(policy.origins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ])
  })

  it('allows a listed origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.example.com')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.example.com'
    )
  })

  it('rejects an unlisted origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com')
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, error: 'Forbidden' })
  })

  it('sends no allow-origin header when rejecting', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects a lookalike host', async () => {
    for (const origin of [
      'https://app.example.com.evil.com',
      'https://notapp.example.com',
      'https://evil.com/?app.example.com',
    ]) {
      const res = await request(app).get('/test').set('Origin', origin)
      expect(res.status).toBe(403)
    }
  })

  it('rejects a scheme downgrade of a listed host', async () => {
    // http:// is not the allowlisted origin, and credentials ride along.
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://app.example.com')
    expect(res.status).toBe(403)
  })

  it('rejects a different port on the listed host', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.example.com:8443')
    expect(res.status).toBe(403)
  })

  it('rejects a request with no Origin header in production', async () => {
    const res = await request(app).get('/test')
    expect(res.status).toBe(403)
  })

  it('allows the listed origin to send credentials', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.example.com')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('tolerates operator formatting in the allowlist', async () => {
    // A trailing slash or uppercase host in CORS_ORIGINS must still match.
    const messy = appFor(
      policyFor(
        'https://app.example.com/,HTTPS://ADMIN.EXAMPLE.COM',
        'production'
      )
    )
    const res = await request(messy)
      .get('/test')
      .set('Origin', 'https://app.example.com')
    expect(res.status).toBe(200)
  })
})

describe('staging allowlist', () => {
  const policy = policyFor('https://staging.example.com', 'staging')
  const app = appFor(policy)

  it('is strict, exactly like production', () => {
    expect(policy.strict).toBe(true)
  })

  it('allows the staged origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://staging.example.com')
    expect(res.status).toBe(200)
  })

  it('rejects the production origin', async () => {
    // Staging holds production-shaped data, so a production frontend must not
    // be able to read it cross-origin.
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.example.com')
    expect(res.status).toBe(403)
  })

  it('rejects an arbitrary origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com')
    expect(res.status).toBe(403)
  })
})

describe('wildcard restriction', () => {
  it('refuses a bare wildcard in production', () => {
    const policy = policyFor('*', 'production')
    expect(policy.wildcardRejected).toBe(true)
    expect(policy.allowAnyOrigin).toBe(false)
    expect(evaluateOrigin(policy, 'https://anything.com').allowed).toBe(false)
  })

  it('refuses a bare wildcard in staging', () => {
    expect(policyFor('*', 'staging').wildcardRejected).toBe(true)
  })

  it('refuses a wildcard smuggled into a list', () => {
    const policy = policyFor('https://app.example.com,*', 'production')
    expect(policy.wildcardRejected).toBe(true)
    expect(evaluateOrigin(policy, 'https://anything.com').allowed).toBe(false)
  })

  it('permits a wildcard in development', async () => {
    const app = appFor(policyFor('*', 'development'))
    const res = await request(app).get('/test').set('Origin', 'https://any.dev')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('https://any.dev')
  })
})

describe('development and test', () => {
  it.each(['development', 'test'])(
    'permits an arbitrary origin in %s',
    async (environment) => {
      const app = appFor(policyFor(undefined, environment))
      const res = await request(app)
        .get('/test')
        .set('Origin', 'https://any.dev')
      expect(res.status).toBe(200)
    }
  )

  it('permits a request with no Origin header', async () => {
    const app = appFor(policyFor(undefined, 'development'))
    const res = await request(app).get('/test')
    expect(res.status).toBe(200)
  })
})

describe('preflight', () => {
  const app = appFor(policyFor(PROD_ORIGINS, 'production'))

  it('answers a preflight from an allowed origin', async () => {
    const res = await preflight(app, 'https://app.example.com', 'Content-Type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toContain('POST')
  })

  it('refuses a preflight from a disallowed origin', async () => {
    const res = await preflight(app, 'https://evil.com', 'Content-Type')
    expect(res.status).toBe(403)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  // Each of these is read by the API. A missing entry here means a legitimate
  // cross-origin request fails preflight in the browser while passing in tests.
  it.each([
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'X-Request-ID',
    'X-Correlation-ID',
    'X-Internal-Token',
    'X-Admin-Token',
    'X-Signature',
    'X-Twilio-Signature',
    'X-Telegram-Bot-Api-Secret-Token',
    'Last-Event-ID',
  ])('allows the %s request header through preflight', async (header) => {
    const res = await preflight(app, 'https://app.example.com', header)
    expect(res.status).toBe(204)
    expect(
      res.headers['access-control-allow-headers']?.toLowerCase()
    ).toContain(header.toLowerCase())
  })

  it('rejects a request header that is not on the allowlist', async () => {
    const res = await preflight(
      app,
      'https://app.example.com',
      'X-Not-A-Real-Header'
    )
    expect(res.headers['access-control-allow-headers'] ?? '').not.toContain(
      'X-Not-A-Real-Header'
    )
  })

  it('exposes the request and rate-limit headers to the browser', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.example.com')
    const exposed = (
      res.headers['access-control-expose-headers'] ?? ''
    ).toLowerCase()
    expect(exposed).toContain('x-request-id')
    expect(exposed).toContain('x-correlation-id')
    expect(exposed).toContain('x-api-version')
  })

  it('caches preflight results where the allowlist is enforced', async () => {
    const res = await preflight(app, 'https://app.example.com', 'Content-Type')
    expect(res.headers['access-control-max-age']).toBe('7200')
  })
})

describe('startup validation', () => {
  it('accepts a valid production allowlist', () => {
    expect(() =>
      validateCorsConfig(policyFor(PROD_ORIGINS, 'production'))
    ).not.toThrow()
  })

  it('rejects an empty allowlist in production', () => {
    expect(() =>
      validateCorsConfig(policyFor(undefined, 'production'))
    ).toThrow(/must be set and non-empty/)
  })

  it('rejects an empty allowlist in staging', () => {
    expect(() => validateCorsConfig(policyFor('', 'staging'))).toThrow(
      /must be set and non-empty/
    )
  })

  it('rejects a wildcard in production', () => {
    expect(() => validateCorsConfig(policyFor('*', 'production'))).toThrow(
      /not permitted/
    )
  })

  it('rejects an unparseable entry', () => {
    expect(() =>
      validateCorsConfig(
        policyFor('https://ok.example.com,not-an-origin', 'production')
      )
    ).toThrow(/not valid origins/)
  })

  it('does not require an allowlist in development', () => {
    expect(() =>
      validateCorsConfig(policyFor(undefined, 'development'))
    ).not.toThrow()
    expect(() =>
      validateCorsConfig(policyFor('*', 'development'))
    ).not.toThrow()
  })

  it('rejects a runtime request when the policy is a wildcard misconfiguration', async () => {
    // A process that somehow booted with `CORS_ORIGINS=*` must still fail
    // closed rather than serve every origin.
    const app = appFor(policyFor('*', 'production'))
    const res = await request(app).get('/test').set('Origin', 'https://any.dev')
    expect(res.status).toBe(403)
  })
})
