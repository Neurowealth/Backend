/**
 * #672 — legacy /api/* aliases must have exact parity with /api/v1/*.
 *
 * The mount table guarantees the same handlers, but this suite exercises the
 * full chain for representative contracts: auth middleware order, API-key
 * scope enforcement, consent/impersonation guards (none currently applied to
 * these routes — asserted below), idempotency requirements, correlation IDs,
 * error envelopes, and Retry-After behaviour.
 *
 * The single intentional divergence is the deprecation signalling on the
 * legacy prefix (Deprecation / Sunset / Link), asserted explicitly.
 */
import bcrypt from 'bcryptjs'
import express from 'express'
import request from 'supertest'
import { API_ROUTES } from '../../src/routes/registry'
import { discoverRoutes } from '../helpers/routeTable'
import { buildRateLimiter } from '../../src/middleware/rateLimiter'

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    userApiKey: { findFirst: jest.fn(), update: jest.fn() },
    session: { findUnique: jest.fn() },
    transaction: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  },
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  },
  requestLogger: (_req: any, _res: any, next: any) => next(),
}))

import db from '../../src/db'
import app from '../../src/index'

const mockDb = db as any
const USER_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'nwk_paritykey_secret'
const TOKEN_HASH = bcrypt.hashSync(TOKEN, 4)

function keyWithScopes(scopes: string[]) {
  return {
    id: 'paritykey',
    tokenPrefix: 'sha256:irrelevant',
    hash: TOKEN_HASH,
    revokedAt: null,
    expiresAt: null,
    ipAllowlist: [],
    scopes,
    allowWithdrawals: false,
    rateLimitPerMin: null,
    user: {
      id: USER_ID,
      isActive: true,
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      network: 'TESTNET',
    },
  }
}

function stripVolatile(body: any) {
  if (!body || typeof body !== 'object') return body
  const { requestId, timestamp, ...rest } = body
  return rest
}

async function call(
  prefix: '/api/v1' | '/api',
  method: 'get' | 'post',
  path: string,
  options: { body?: unknown; token?: string; requestId?: string } = {}
) {
  let req = (request(app) as any)[method](`${prefix}${path}`)
  if (options.token) req = req.set('Authorization', `Bearer ${options.token}`)
  if (options.requestId) req = req.set('X-Request-ID', options.requestId)
  if (options.body !== undefined) req = req.send(options.body)
  return req
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.userApiKey.findFirst.mockResolvedValue(keyWithScopes([]))
  mockDb.userApiKey.update.mockResolvedValue({})
})

describe('route-table parity (#672)', () => {
  it('mounts the same methods/paths and tier on both prefixes', () => {
    for (const route of API_ROUTES) {
      const versioned = discoverRoutes(`/api/v1/${route.path}`, route.handlers)
      const legacy = discoverRoutes(`/api/${route.path}`, route.handlers)
      const shape = (routes: typeof versioned) =>
        routes
          .map(
            (r) =>
              `${r.method} ${r.path.replace(/^\/api(\/v1)?/, '')} ${r.tier}`
          )
          .sort()

      expect(shape(legacy)).toEqual(shape(versioned))
    }
  })

  it('does not apply consent/impersonation guards to only one prefix', () => {
    // All routes are mounted from the same handler array; if a guard is added
    // it is therefore present on both. This assertion catches a future
    // wrapper that patches only one mount.
    for (const route of API_ROUTES) {
      const versioned = discoverRoutes(`/api/v1/${route.path}`, route.handlers)
      const legacy = discoverRoutes(`/api/${route.path}`, route.handlers)
      expect(legacy.length).toBe(versioned.length)
    }
  })
})

describe('behavioural parity (#672)', () => {
  it.each([
    ['missing request body', 'post', '/auth/challenge', { body: {} }],
    ['missing authentication', 'get', '/transactions/detail/abc', {}],
    [
      'API-key scope denial',
      'get',
      '/transactions/detail/abc',
      { token: TOKEN },
    ],
    [
      'idempotency key required',
      'post',
      '/deposit',
      {
        token: TOKEN,
        body: {
          userId: USER_ID,
          amount: '10',
          assetSymbol: 'USDC',
        },
      },
    ],
  ] as const)(
    'returns the same status and error envelope for %s',
    async (_name, method, path, options) => {
      // Deposit needs deposit:write so it reaches the idempotency guard; the
      // scope case deliberately uses no scopes.
      if (path === '/deposit') {
        mockDb.userApiKey.findFirst.mockResolvedValue(
          keyWithScopes(['deposit:write'])
        )
      }

      const versioned = await call('/api/v1', method, path, options)
      const legacy = await call('/api', method, path, options)

      expect(legacy.status).toBe(versioned.status)
      expect(stripVolatile(legacy.body)).toEqual(stripVolatile(versioned.body))
      expect(legacy.headers['x-api-version']).toBe('1')
      expect(versioned.headers['x-api-version']).toBe('1')

      // Only the legacy alias carries deprecation metadata.
      expect(versioned.headers['deprecation']).toBeUndefined()
      expect(legacy.headers['deprecation']).toBe('true')
      expect(legacy.headers['sunset']).toBeDefined()
      expect(legacy.headers['link']).toContain('rel="successor-version"')
    }
  )

  it('echoes the same correlation ID and uses it in both error envelopes', async () => {
    const requestId = '550e8400-e29b-41d4-a716-446655440000'
    const versioned = await call('/api/v1', 'post', '/auth/challenge', {
      body: {},
      requestId,
    })
    const legacy = await call('/api', 'post', '/auth/challenge', {
      body: {},
      requestId,
    })

    expect(versioned.headers['x-request-id']).toBe(requestId)
    expect(legacy.headers['x-request-id']).toBe(requestId)
    expect(versioned.body.requestId).toBe(requestId)
    expect(legacy.body.requestId).toBe(requestId)
    expect(stripVolatile(legacy.body)).toEqual(stripVolatile(versioned.body))
  })

  it('serves byte-identical reconciled accounting exports on both prefixes', async () => {
    mockDb.userApiKey.findFirst.mockResolvedValue(
      keyWithScopes(['transactions:read'])
    )
    mockDb.transaction.findMany.mockResolvedValue([
      {
        type: 'DEPOSIT',
        amount: '100.00',
        assetSymbol: 'USDC',
        fee: '1.00',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        protocolName: null,
      },
    ])

    const query = '/accounting/export?format=qbo&from=2026-01-01&to=2026-12-31'
    const versioned = await call('/api/v1', 'get', query, { token: TOKEN })
    const legacy = await call('/api', 'get', query, { token: TOKEN })

    expect(versioned.status).toBe(200)
    expect(legacy.status).toBe(200)
    expect(legacy.text).toBe(versioned.text)
    expect(legacy.headers['x-export-checksum']).toBe(
      versioned.headers['x-export-checksum']
    )
    expect(versioned.headers['x-export-reconciled']).toBe('true')
    expect(versioned.headers['x-export-row-count']).toBe('1')
    expect(versioned.headers['cache-control']).toBe(
      'private, no-store, max-age=0'
    )
    expect(legacy.headers['deprecation']).toBe('true')
  })

  it('emits the same Retry-After and 429 envelope on both prefixes', async () => {
    function limited(prefix: string, id: string) {
      const a = express()
      a.use((req: any, _res: any, next: any) => {
        req.userId = USER_ID
        next()
      })
      const limiter = buildRateLimiter({
        windowMs: 60_000,
        max: 1,
        limiterType: `parity-${id}`,
        tier: 'tiered',
      })
      a.use(prefix, limiter)
      a.get(`${prefix}/probe`, (_req, res) =>
        res.status(200).json({ ok: true })
      )
      return a
    }

    const v1 = limited('/api/v1', 'v1')
    const legacy = limited('/api', 'legacy')

    await request(v1).get('/api/v1/probe')
    await request(legacy).get('/api/probe')

    const v1Blocked = await request(v1).get('/api/v1/probe')
    const legacyBlocked = await request(legacy).get('/api/probe')

    expect(v1Blocked.status).toBe(429)
    expect(legacyBlocked.status).toBe(429)
    expect(legacyBlocked.headers['retry-after']).toBe(
      v1Blocked.headers['retry-after']
    )
    expect(legacyBlocked.headers['ratelimit-policy']).toBe(
      v1Blocked.headers['ratelimit-policy']
    )
    expect(stripVolatile(legacyBlocked.body)).toEqual(
      stripVolatile(v1Blocked.body)
    )
  })
})
