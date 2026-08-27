/**
 * #285 — Strategy marketplace routes integration test.
 *
 * Mounts the real router on a minimal Express app with only auth and the DB
 * mocked, so the request travels through the REAL validators, the REAL service
 * (query layer) and the REAL mappers. That matters: the acceptance criterion is
 * that no marketplace response can identify a publisher, and mocking the
 * service would test nothing but the mock.
 *
 * The two headline assertions are:
 *   * PII — no response carries userId, walletAddress, phone, email, a balance,
 *     or anything shaped like a Stellar address
 *   * eligibility/publication — ineligible and unpublished strategies are
 *     absent from the leaderboard entirely
 */
const mockUserId = '11111111-1111-4111-8111-111111111111'
const publisherUserId = '99999999-9999-4999-8999-999999999999'
const strategyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

import request from 'supertest'
import express from 'express'

// --- Auth: stub requireAuth to inject a fixed identity -----------------------
jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = mockUserId
    req.auth = { userId: mockUserId, walletAddress: 'GWALLET_USER_1' }
    next()
  },
  enforceUserAccess: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../src/utils/twilio-client', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue('SM1'),
}))

jest.mock('../../src/db', () => ({ __esModule: true, default: {} }))

import db from '../../src/db'
import strategiesRouter from '../../src/routes/strategies'

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/strategies', strategiesRouter)
  return app
}

const app = buildApp()

/** A DB row shaped exactly as the service's select produces it. */
function metricRow(overrides: Record<string, unknown> = {}) {
  return {
    apy: 12.5,
    sharpe: 1.8,
    sampleCount: 640,
    trackRecordDays: 45,
    windowDays: 30,
    computedAt: new Date('2026-07-25T00:00:00.000Z'),
    publishedStrategy: {
      id: strategyId,
      label: 'Steady conservative yield',
      strategyConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
      configVersion: 3,
      isPublished: true,
      publishedAt: new Date('2026-06-01T00:00:00.000Z'),
    },
    ...overrides,
  }
}

beforeEach(() => {
  mockDb.$transaction = jest.fn(async (fn: any) => fn(mockDb))
  mockDb.user = { findUnique: jest.fn() }
  mockDb.publishedStrategy = {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    upsert: jest.fn(),
    update: jest.fn(),
  }
  mockDb.strategyFollow = {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  }
  mockDb.publishedStrategyMetric = {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  }
  mockDb.strategyAttribution = {
    findMany: jest.fn().mockResolvedValue([]),
  }
})

describe('GET /api/v1/strategies/marketplace — anonymity', () => {
  it('returns no publisher-identifying field on any entry', async () => {
    mockDb.publishedStrategyMetric.count.mockResolvedValue(1)
    mockDb.publishedStrategyMetric.findMany.mockResolvedValue([metricRow()])

    const res = await request(app).get('/api/v1/strategies/marketplace')

    expect(res.status).toBe(200)
    expect(res.body.strategies).toHaveLength(1)

    const entry = res.body.strategies[0]
    for (const forbidden of [
      'userId',
      'user',
      'walletAddress',
      'phone',
      'email',
      'displayName',
      'avatarUrl',
      'currentValue',
      'depositedAmount',
      'yieldEarned',
      'principalAmount',
      'balance',
    ]) {
      expect(entry).not.toHaveProperty(forbidden)
    }

    // Only derived, relative statistics — never an absolute currency amount.
    expect(entry).toMatchObject({
      strategyId,
      label: 'Steady conservative yield',
      apy: 12.5,
      sharpe: 1.8,
      trackRecordDays: 45,
      sampleCount: 640,
      windowDays: 30,
    })
  })

  it('sweeps the whole response body for Stellar addresses and the publisher id', async () => {
    mockDb.publishedStrategyMetric.count.mockResolvedValue(1)
    mockDb.publishedStrategyMetric.findMany.mockResolvedValue([metricRow()])

    const res = await request(app).get('/api/v1/strategies/marketplace')
    const raw = JSON.stringify(res.body)

    expect(raw).not.toMatch(/G[A-Z2-7]{55}/)
    expect(raw).not.toMatch(/C[A-Z2-7]{55}/)
    expect(raw).not.toContain(publisherUserId)
  })

  it('scopes the query to eligible metrics of published strategies only', async () => {
    // Ineligible and unpublished rows never reach the mapper — they are
    // excluded by the WHERE clause, not filtered out afterwards.
    await request(app).get('/api/v1/strategies/marketplace')

    expect(mockDb.publishedStrategyMetric.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          windowDays: 30,
          isEligible: true,
          publishedStrategy: { isPublished: true },
        },
      })
    )
  })

  it('returns an empty page rather than an error when nothing is eligible', async () => {
    const res = await request(app).get('/api/v1/strategies/marketplace')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 0, strategies: [] })
  })
})

describe('GET /api/v1/strategies/marketplace — query validation', () => {
  it('defaults to sharpe over a 30d window with a leaderboard-sized page', async () => {
    const res = await request(app).get('/api/v1/strategies/marketplace')
    expect(res.body).toMatchObject({
      page: 1,
      limit: 20,
      window: '30d',
      sortBy: 'sharpe',
    })
  })

  it('accepts sortBy=apy and window=90d', async () => {
    const res = await request(app).get(
      '/api/v1/strategies/marketplace?sortBy=apy&window=90d&page=2&limit=5'
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      page: 2,
      limit: 5,
      window: '90d',
      sortBy: 'apy',
    })
    expect(mockDb.publishedStrategyMetric.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 })
    )
  })

  it('rejects window=1y with a 400 naming the retention limit', async () => {
    // Snapshots are hard-deleted at 90 days, so a 1y window would silently
    // report a 90-day figure under a wrong label.
    const res = await request(app).get(
      '/api/v1/strategies/marketplace?window=1y'
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('90 days')
  })

  it('rejects an unknown sort field', async () => {
    const res = await request(app).get(
      '/api/v1/strategies/marketplace?sortBy=totalReturn'
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/v1/strategies/publish', () => {
  function publishedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: strategyId,
      label: 'Steady conservative yield',
      strategyConfig: { strategyName: 'MAX_YIELD' },
      configVersion: 1,
      isPublished: true,
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }
  }

  it('publishes and echoes back no userId', async () => {
    mockDb.publishedStrategy.upsert.mockResolvedValue(publishedRow())

    const res = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: 'Steady conservative yield',
        strategyConfig: { strategyName: 'MAX_YIELD' },
      })

    expect(res.status).toBe(200)
    expect(res.body.strategy).not.toHaveProperty('userId')
    expect(res.body.strategy.id).toBe(strategyId)
  })

  it('rejects a label containing a Stellar address', async () => {
    const res = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        strategyConfig: { strategyName: 'MAX_YIELD' },
      })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/Stellar address/)
  })

  it('rejects a label containing a long hex run', async () => {
    const res = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: `key ${'a1b2c3d4'.repeat(4)}`,
        strategyConfig: { strategyName: 'MAX_YIELD' },
      })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/hexadecimal/)
  })

  it('rejects an over-long label and an empty one', async () => {
    const tooLong = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: 'x'.repeat(61),
        strategyConfig: { strategyName: 'MAX_YIELD' },
      })
    expect(tooLong.status).toBe(400)

    const empty = await request(app)
      .post('/api/v1/strategies/publish')
      .send({ label: '   ', strategyConfig: { strategyName: 'MAX_YIELD' } })
    expect(empty.status).toBe(400)
  })

  it('rejects GOAL_TRACKING as unpublishable', async () => {
    const res = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: 'Goal chaser',
        strategyConfig: { strategyName: 'GOAL_TRACKING' },
      })
    expect(res.status).toBe(400)
  })

  it('rejects TARGET_ALLOCATION without allocations, and allocations that do not sum to 100', async () => {
    const missing = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: 'Balanced',
        strategyConfig: { strategyName: 'TARGET_ALLOCATION' },
      })
    expect(missing.status).toBe(400)

    const lopsided = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: 'Balanced',
        strategyConfig: {
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 60, Luma: 60 },
        },
      })
    expect(lopsided.status).toBe(400)
    expect(JSON.stringify(lopsided.body)).toContain('sum to 100')
  })

  it('accepts a valid TARGET_ALLOCATION config', async () => {
    mockDb.publishedStrategy.upsert.mockResolvedValue(
      publishedRow({
        strategyConfig: {
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 60, Luma: 40 },
        },
      })
    )

    const res = await request(app)
      .post('/api/v1/strategies/publish')
      .send({
        label: 'Balanced',
        strategyConfig: {
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 60, Luma: 40 },
        },
      })

    expect(res.status).toBe(200)
  })
})

describe('POST /api/v1/strategies/unpublish', () => {
  it('404s when the caller never published', async () => {
    const res = await request(app).post('/api/v1/strategies/unpublish')
    expect(res.status).toBe(404)
  })

  it('delists and reports isPublished false', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue({
      id: strategyId,
      isPublished: true,
    })
    mockDb.publishedStrategy.update.mockResolvedValue({
      id: strategyId,
      label: 'Steady conservative yield',
      strategyConfig: { strategyName: 'MAX_YIELD' },
      configVersion: 2,
      isPublished: false,
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await request(app).post('/api/v1/strategies/unpublish')
    expect(res.status).toBe(200)
    expect(res.body.strategy.isPublished).toBe(false)
    expect(res.body.strategy).not.toHaveProperty('userId')
  })
})

describe('follow / unfollow', () => {
  it('409s on a self-follow', async () => {
    mockDb.publishedStrategy.findFirst.mockResolvedValue({
      id: strategyId,
      userId: mockUserId,
      label: 'Mine',
      strategyConfig: { strategyName: 'MAX_YIELD' },
      configVersion: 1,
    })

    const res = await request(app).post(
      `/api/v1/strategies/${strategyId}/follow`
    )
    expect(res.status).toBe(409)
  })

  it('404s when following an unpublished or unknown strategy', async () => {
    const res = await request(app).post(
      `/api/v1/strategies/${strategyId}/follow`
    )
    expect(res.status).toBe(404)
  })

  it('creates a follow and returns the applied snapshot without a publisher id', async () => {
    mockDb.publishedStrategy.findFirst.mockResolvedValue({
      id: strategyId,
      userId: publisherUserId,
      label: 'Steady conservative yield',
      strategyConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
      configVersion: 4,
    })
    mockDb.strategyFollow.create.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: strategyId,
      appliedConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
      appliedConfigVersion: 4,
      appliedAt: new Date(),
      followedAt: new Date(),
      publishedStrategy: {
        id: strategyId,
        label: 'Steady conservative yield',
        strategyConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
        configVersion: 4,
        isPublished: true,
        publishedAt: new Date(),
      },
    })

    const res = await request(app).post(
      `/api/v1/strategies/${strategyId}/follow`
    )

    expect(res.status).toBe(201)
    expect(res.body.follow.appliedConfigVersion).toBe(4)
    expect(JSON.stringify(res.body)).not.toContain(publisherUserId)
    expect(JSON.stringify(res.body)).not.toMatch(/G[A-Z2-7]{55}/)
  })

  it('rejects a non-uuid strategy id', async () => {
    const res = await request(app).post('/api/v1/strategies/not-a-uuid/follow')
    expect(res.status).toBe(400)
  })

  it('404s when unfollowing with no active follow', async () => {
    const res = await request(app).post(
      `/api/v1/strategies/${strategyId}/unfollow`
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/strategies/following', () => {
  it('returns { follow: null } rather than 404 when following nothing', async () => {
    const res = await request(app).get('/api/v1/strategies/following')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ follow: null })
  })

  it('surfaces the applied snapshot alongside a delisted strategy', async () => {
    mockDb.strategyFollow.findFirst.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: strategyId,
      appliedConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
      appliedConfigVersion: 4,
      appliedAt: new Date(),
      followedAt: new Date(),
      publishedStrategy: {
        id: strategyId,
        label: 'Steady conservative yield',
        strategyConfig: { strategyName: 'MAX_YIELD', riskCeiling: 85 },
        configVersion: 5,
        isPublished: false,
        publishedAt: new Date(),
      },
    })

    const res = await request(app).get('/api/v1/strategies/following')

    expect(res.status).toBe(200)
    // The follower keeps running v4 even though the listing moved on and was
    // delisted — that is the whole point of the snapshot.
    expect(res.body.follow.appliedConfigVersion).toBe(4)
    expect(res.body.follow.appliedConfig).toEqual({
      strategyName: 'MAX_YIELD',
      riskCeiling: 70,
    })
    expect(res.body.follow.strategy.isPublished).toBe(false)
    expect(JSON.stringify(res.body)).not.toContain(publisherUserId)
  })

  it('reports an orphaned follow with a null strategy', async () => {
    mockDb.strategyFollow.findFirst.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: null,
      appliedConfig: { strategyName: 'MAX_YIELD' },
      appliedConfigVersion: 4,
      appliedAt: new Date(),
      followedAt: new Date(),
      publishedStrategy: null,
    })

    const res = await request(app).get('/api/v1/strategies/following')
    expect(res.status).toBe(200)
    expect(res.body.follow.strategy).toBeNull()
    expect(res.body.follow.appliedConfig).toEqual({ strategyName: 'MAX_YIELD' })
  })
})
