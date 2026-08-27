/**
 * #322 — Allocation-suggestion routes integration test.
 *
 * Mounts the REAL portfolio router on a minimal Express app with only auth and
 * the DB mocked, so a request travels through the real validators, the real
 * service, the real optimizer and the real mappers. Mocking the service would
 * test nothing but the mock, and the properties that matter here — owner
 * scoping, the 429 paths, and the fact that a response is never mistakable for
 * an applied change — are all end-to-end properties of that chain.
 */
const ownerUserId = '11111111-1111-4111-8111-111111111111'
const otherUserId = '22222222-2222-4222-8222-222222222222'

import request from 'supertest'
import express from 'express'

// --- Auth: inject a fixed identity, and keep enforceUserAccess REAL ----------
// enforceUserAccess is the thing under test for owner scoping, so it is the one
// piece of the auth chain that must not be stubbed away.
jest.mock('../../src/middleware/authenticate', () => {
  const actual = jest.requireActual('../../src/middleware/authenticate')
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.userId = ownerUserId
      req.auth = { userId: ownerUserId, walletAddress: 'GWALLET_OWNER' }
      next()
    },
    enforceUserAccess: actual.enforceUserAccess,
  }
})

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
  requestLogger: (_req: any, _res: any, next: any) => next(),
}))

/**
 * The optimizer rate limiter is a MODULE-LEVEL singleton with a shared
 * express-rate-limit store, so its 5-requests-per-minute budget would be
 * consumed across every test in this file regardless of how many Express apps
 * are built — the sixth POST below would 429 for the wrong reason and the
 * suite would be order-dependent. Stubbed to a pass-through here; the limiter's
 * own 429/Retry-After behaviour is generic express-rate-limit config, and the
 * genuinely new in-flight logic is covered by tests/unit/utils/concurrency.test.ts
 * plus the concurrency case below.
 */
jest.mock('../../src/middleware/rateLimiter', () => ({
  optimizerRateLimiter: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/db', () => ({ __esModule: true, default: {} }))

import db from '../../src/db'
import portfolioRouter from '../../src/routes/portfolio'

const mockDb = db as any

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date()

function rateRows(spec: Record<string, number>, days = 90) {
  const rows: any[] = []
  for (let d = 0; d < days; d++) {
    const fetchedAt = new Date(NOW.getTime() - (days - 1 - d) * DAY)
    for (const [protocolName, base] of Object.entries(spec)) {
      rows.push({
        protocolName,
        assetSymbol: 'USDC',
        supplyApy: base + Math.sin((d + protocolName.length) / 6),
        fetchedAt,
      })
    }
  }
  return rows
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/portfolio', portfolioRouter)
  return app
}

function setupDb(overrides: { suggestions?: any[]; total?: number } = {}) {
  mockDb.user = {
    findUnique: jest.fn().mockResolvedValue({
      id: ownerUserId,
      riskTolerance: 5,
      strategyConfig: null,
    }),
  }
  mockDb.strategyFollow = { findFirst: jest.fn().mockResolvedValue(null) }
  mockDb.savingsGoal = { findFirst: jest.fn().mockResolvedValue(null) }
  mockDb.protocolRate = {
    findMany: jest
      .fn()
      .mockResolvedValue(rateRows({ Blend: 11, Luma: 8, Nova: 6 })),
  }
  mockDb.protocolRiskScore = {
    findMany: jest.fn().mockResolvedValue([
      { protocolName: 'Blend', score: 72, insufficientHistory: false },
      { protocolName: 'Luma', score: 61, insufficientHistory: false },
      { protocolName: 'Nova', score: 88, insufficientHistory: false },
    ]),
  }
  mockDb.position = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.allocationSuggestion = {
    create: jest.fn().mockResolvedValue({ id: 'suggestion-1' }),
    count: jest.fn().mockResolvedValue(overrides.total ?? 0),
    findMany: jest.fn().mockResolvedValue(overrides.suggestions ?? []),
  }
}

beforeEach(() => setupDb())

describe('POST /api/v1/portfolio/:userId/suggest-allocation', () => {
  it('returns an advisory suggestion for the owner', async () => {
    const res = await request(buildApp())
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.isSuggestion).toBe(true)
    expect(res.body.disclaimer).toEqual(expect.any(String))
    expect(res.body.status).toBe('ok')

    const sum = Object.values(
      res.body.weights as Record<string, number>
    ).reduce((s, v) => s + v, 0)
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01)
  })

  it('carries the efficient frontier and the backtest caveat', async () => {
    const res = await request(buildApp())
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({ frontierPoints: 6 })

    expect(res.status).toBe(200)
    expect(res.body.outcome.frontier).toHaveLength(6)
    expect(res.body.backtest.caveat).toEqual(
      expect.stringContaining('one protocol at a time')
    )
  })

  it('rejects acting on another user before any work is done', async () => {
    // enforceUserAccess answers 401 (not 403) for a cross-user target — see
    // AUTH_ERRORS.UNAUTHORIZED in src/middleware/authenticate.ts. Asserted as
    // the real behaviour rather than the shape one might assume.
    const res = await request(buildApp())
      .post(`/api/v1/portfolio/${otherUserId}/suggest-allocation`)
      .send({})

    expect(res.status).toBe(401)
    expect(mockDb.allocationSuggestion.create).not.toHaveBeenCalled()
    expect(mockDb.protocolRate.findMany).not.toHaveBeenCalled()
  })

  it('400s on an unknown body field rather than silently ignoring it', async () => {
    // A typo'd knob would otherwise return a confident answer computed over the
    // wrong window.
    const res = await request(buildApp())
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({ lookback: 30 })

    expect(res.status).toBe(400)
  })

  it('400s on an out-of-range frontierPoints', async () => {
    const res = await request(buildApp())
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({ frontierPoints: 500 })

    expect(res.status).toBe(400)
  })

  it('rejects a non-uuid userId', async () => {
    // Ownership is checked BEFORE validation (requireAuth -> enforceUserAccess
    // -> validate), so a bogus id belonging to nobody is an auth failure, not a
    // schema failure. Auth-before-validation is the correct order.
    const res = await request(buildApp())
      .post('/api/v1/portfolio/not-a-uuid/suggest-allocation')
      .send({})

    expect(res.status).toBe(401)
  })

  it('404s for a user that does not exist', async () => {
    mockDb.user.findUnique.mockResolvedValue(null)

    const res = await request(buildApp())
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({})

    expect(res.status).toBe(404)
  })

  it('429s the second concurrent optimization for the same user', async () => {
    // The per-user in-flight bound is 1. Hold the first request inside the
    // service by stalling a DB read, then fire the second.
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    let call = 0
    mockDb.protocolRate.findMany.mockImplementation(async () => {
      call++
      if (call === 1) await gate
      return rateRows({ Blend: 11, Luma: 8, Nova: 6 })
    })

    const app = buildApp()
    // `.then()` is what actually dispatches a supertest request. Without it the
    // first request would never enter the service, the gate below would be hit
    // by the SECOND request instead, and the test would deadlock.
    const first = request(app)
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({})
      .then((r) => r)

    // Give the first request time to enter the service and take the slot.
    await new Promise((r) => setTimeout(r, 100))

    const second = await request(app)
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({})

    expect(second.status).toBe(429)
    expect(second.headers['retry-after']).toBeDefined()
    expect(second.body.error).toEqual(
      expect.stringContaining('already running')
    )

    releaseFirst()
    expect((await first).status).toBe(200)
  })

  it('releases the concurrency slot after a failure', async () => {
    // A leaked slot would wedge this user out of the endpoint permanently.
    mockDb.user.findUnique.mockResolvedValueOnce(null)
    const app = buildApp()

    const failed = await request(app)
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({})
    expect(failed.status).toBe(404)

    const next = await request(app)
      .post(`/api/v1/portfolio/${ownerUserId}/suggest-allocation`)
      .send({})
    expect(next.status).toBe(200)
  })
})

describe('GET /api/v1/portfolio/:userId/suggestions', () => {
  const row = {
    id: 'sug-1',
    status: 'ok',
    inputHash: 'sha256:abc',
    weights: { Blend: 60, Luma: 40 },
    frontier: [],
    backtestSummary: null,
    riskTolerance: 5,
    effectiveRiskCeiling: null,
    reason: null,
    computedAt: new Date('2026-08-17T00:00:00Z'),
  }

  it('returns the paginated history for the owner', async () => {
    setupDb({ suggestions: [row], total: 1 })

    const res = await request(buildApp()).get(
      `/api/v1/portfolio/${ownerUserId}/suggestions`
    )

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.page).toBe(1)
    expect(res.body.limit).toBe(20)
    expect(res.body.suggestions).toHaveLength(1)
    expect(res.body.suggestions[0]).toMatchObject({
      id: 'sug-1',
      isSuggestion: true,
      status: 'ok',
      weights: { Blend: 60, Luma: 40 },
    })
  })

  it('marks every stored row as a suggestion, never an applied change', async () => {
    setupDb({ suggestions: [row, { ...row, id: 'sug-2' }], total: 2 })

    const res = await request(buildApp()).get(
      `/api/v1/portfolio/${ownerUserId}/suggestions`
    )

    for (const s of res.body.suggestions) {
      expect(s.isSuggestion).toBe(true)
    }
  })

  it('never leaks userId in a stored row', async () => {
    setupDb({ suggestions: [{ ...row, userId: ownerUserId }], total: 1 })

    const res = await request(buildApp()).get(
      `/api/v1/portfolio/${ownerUserId}/suggestions`
    )

    expect(res.body.suggestions[0].userId).toBeUndefined()
  })

  it('applies page and limit to the query', async () => {
    setupDb({ suggestions: [], total: 40 })

    const res = await request(buildApp()).get(
      `/api/v1/portfolio/${ownerUserId}/suggestions?page=3&limit=10`
    )

    expect(res.status).toBe(200)
    const args = mockDb.allocationSuggestion.findMany.mock.calls[0][0]
    expect(args.skip).toBe(20)
    expect(args.take).toBe(10)
    expect(args.where).toEqual({ userId: ownerUserId })
    expect(args.orderBy).toEqual({ computedAt: 'desc' })
  })

  it('rejects listing another user suggestions', async () => {
    const res = await request(buildApp()).get(
      `/api/v1/portfolio/${otherUserId}/suggestions`
    )

    expect(res.status).toBe(401)
    expect(mockDb.allocationSuggestion.findMany).not.toHaveBeenCalled()
  })

  it('400s on a limit above the cap', async () => {
    const res = await request(buildApp()).get(
      `/api/v1/portfolio/${ownerUserId}/suggestions?limit=500`
    )

    expect(res.status).toBe(400)
  })
})

describe('route ordering', () => {
  it('does not swallow "suggestions" as a userId', async () => {
    // GET /:userId is registered after these. If ordering regressed, the
    // request would match GET /:userId with userId="<uuid>" and return a
    // portfolio body instead of being scoped as a suggestions listing.
    const res = await request(buildApp()).get(
      `/api/v1/portfolio/${otherUserId}/suggestions`
    )
    expect(res.status).toBe(401)
    expect(res.body.positions).toBeUndefined()
  })
})
