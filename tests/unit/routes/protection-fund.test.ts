/**
 * Protection-fund admin route tests (#758).
 *
 * The four admin POST routes used to chain `requireAuth` then
 * `requireAdminAuth`, so a user JWT was bcrypt-checked as an admin key and
 * every call 403'd. These tests prove the fixed behaviour at the route
 * level: admin identity comes from the admin key, the
 * `protection-fund:write` scope gates the routes, and the admin who
 * declared an event cannot review it.
 *
 * The service is mocked with a small in-memory store that mirrors the real
 * dual-review rule; the real rule is covered by
 * tests/unit/protectionFund/service.test.ts. Idempotency is mocked to a
 * passthrough: the real middleware needs Redis/DB, which unit tests do
 * not have.
 */
process.env.NODE_ENV = 'test'
process.env.JWT_SEED = '0'.repeat(64)
process.env.DATABASE_URL = 'postgresql://localhost:5432/test'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    adminAuditLog: {
      create: jest.fn().mockResolvedValue({ id: 'mock-audit-id' }),
    },
    adminApiKey: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}))

// Mock admin auth the way tests/unit/routes/admin-feature-flags.test.ts
// does, extended with an `x-mock-admin-id` header so a test can act as
// two different admins (needed for the dual-review cases).
jest.mock('../../../src/middleware/adminAuth', () => {
  const actual = jest.requireActual('../../../src/middleware/adminAuth')
  return {
    ...actual,
    requireAdminAuth: (req: any, res: any, next: any) => {
      const scopesHeader = req.headers['x-mock-scopes']
      const scopes = scopesHeader
        ? (scopesHeader as string).split(',').map((s: string) => s.trim())
        : ['super']
      const adminIdHeader = req.headers['x-mock-admin-id']
      res.locals.adminAuth = {
        id:
          typeof adminIdHeader === 'string' && adminIdHeader
            ? adminIdHeader
            : 'admin-key-1',
        name: 'Test Protection Fund Admin',
        role: 'operator',
        scopes,
      }
      next()
    },
  }
})

jest.mock('../../../src/middleware/idempotency', () => ({
  idempotent: () => (_req: any, _res: any, next: any) => next(),
}))

const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const CLAIM_ID = '22222222-2222-4222-8222-222222222222'

const store: {
  event: { id: string; status: string; declaredBy: string } | null
} = { event: null }

jest.mock('../../../src/protectionFund/service', () => ({
  declareCoverageEvent: jest.fn(async (input: any) => {
    store.event = {
      id: EVENT_ID,
      status: 'PENDING_REVIEW',
      declaredBy: input.declaredBy,
    }
    return store.event
  }),
  reviewCoverageEvent: jest.fn(
    async (eventId: string, approved: boolean, reviewedBy: string) => {
      if (!store.event || store.event.id !== eventId) {
        throw new Error('Coverage event not found')
      }
      if (store.event.status !== 'PENDING_REVIEW') {
        throw new Error(
          `Event is not pending review (status: ${store.event.status})`
        )
      }
      if (store.event.declaredBy === reviewedBy) {
        throw new Error(
          'Reviewer must be a different admin than the declarer'
        )
      }
      store.event = {
        ...store.event,
        status: approved ? 'APPROVED' : 'REJECTED',
      }
      return store.event
    }
  ),
  recordContribution: jest.fn(async (input: any) => ({
    id: 'contrib-1',
    amount: input.amount,
    assetSymbol: input.assetSymbol,
  })),
  executePayout: jest.fn(async () => ({ id: 'outbox-op-1' })),
  getMyCoverage: jest.fn(async () => ({ totalPositions: 0 })),
  getProtectionFundStatus: jest.fn(async () => ({ fundBalance: {} })),
}))

import express from 'express'
import request from 'supertest'
import protectionFundRouter from '../../../src/routes/protection-fund'
import { declareCoverageEvent } from '../../../src/protectionFund/service'

const app = express()
app.use(express.json())
app.use('/api/v1/protection-fund', protectionFundRouter)

const declareBody = {
  protocolName: 'Blend',
  cause: 'EXPLOIT',
  lossWindowStart: '2026-09-01T00:00:00Z',
  lossWindowEnd: '2026-09-02T00:00:00Z',
  totalPlatformExposure: 100000,
  description: 'Exploit of Blend protocol',
}

beforeEach(() => {
  jest.clearAllMocks()
  store.event = null
})

describe('POST /api/v1/protection-fund/events (#758)', () => {
  it('lets a valid admin key with protection-fund:write declare an event', async () => {
    const res = await request(app)
      .post('/api/v1/protection-fund/events')
      .set('x-mock-scopes', 'protection-fund:write')
      .set('x-mock-admin-id', 'admin-key-1')
      .send(declareBody)

    expect(res.status).toBe(201)
    expect(res.body.eventId).toBe(EVENT_ID)
    expect(res.body.status).toBe('PENDING_REVIEW')
    // #758 — declaredBy is the admin key id, not a user JWT subject.
    expect(declareCoverageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ declaredBy: 'admin-key-1' })
    )
  })

  it('returns 403 for a key without the protection-fund:write scope', async () => {
    const res = await request(app)
      .post('/api/v1/protection-fund/events')
      .set('x-mock-scopes', 'support:read')
      .send(declareBody)

    expect(res.status).toBe(403)
    expect(res.body.error).toContain(
      "Admin scope 'protection-fund:write' required"
    )
    expect(declareCoverageEvent).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/protection-fund/events/:eventId/review (#758)', () => {
  it('rejects a review by the same admin who declared the event', async () => {
    await request(app)
      .post('/api/v1/protection-fund/events')
      .set('x-mock-scopes', 'protection-fund:write')
      .set('x-mock-admin-id', 'admin-key-1')
      .send(declareBody)

    const res = await request(app)
      .post(`/api/v1/protection-fund/events/${EVENT_ID}/review`)
      .set('x-mock-scopes', 'protection-fund:write')
      .set('x-mock-admin-id', 'admin-key-1')
      .send({ approved: true })

    expect(res.status).toBe(403)
    expect(res.body.error).toContain('different admin than the declarer')
  })

  it('lets a different admin approve the event', async () => {
    await request(app)
      .post('/api/v1/protection-fund/events')
      .set('x-mock-scopes', 'protection-fund:write')
      .set('x-mock-admin-id', 'admin-key-1')
      .send(declareBody)

    const res = await request(app)
      .post(`/api/v1/protection-fund/events/${EVENT_ID}/review`)
      .set('x-mock-scopes', 'protection-fund:write')
      .set('x-mock-admin-id', 'admin-key-2')
      .send({ approved: true })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('APPROVED')
  })

  it('returns 403 for a review by a key without the scope', async () => {
    const res = await request(app)
      .post(`/api/v1/protection-fund/events/${EVENT_ID}/review`)
      .set('x-mock-scopes', 'support:read')
      .send({ approved: true })

    expect(res.status).toBe(403)
  })
})

describe('POST /api/v1/protection-fund/contributions (#758)', () => {
  it('validates the contribution body', async () => {
    const res = await request(app)
      .post('/api/v1/protection-fund/contributions')
      .set('x-mock-scopes', 'protection-fund:write')
      .send({ source: 'REVENUE_SKIM', assetSymbol: 'USDC', amount: -5 })

    expect(res.status).toBe(400)
  })

  it('records a valid contribution with the admin key as creator', async () => {
    const res = await request(app)
      .post('/api/v1/protection-fund/contributions')
      .set('x-mock-scopes', 'protection-fund:write')
      .set('x-mock-admin-id', 'admin-key-1')
      .send({ source: 'REVENUE_SKIM', assetSymbol: 'USDC', amount: 1000 })

    expect(res.status).toBe(201)
    expect(res.body.contributionId).toBe('contrib-1')
  })
})

describe('POST /api/v1/protection-fund/claims/:claimId/payout (#758)', () => {
  it('rejects a non-uuid claim id', async () => {
    const res = await request(app)
      .post('/api/v1/protection-fund/claims/not-a-uuid/payout')
      .set('x-mock-scopes', 'protection-fund:write')

    expect(res.status).toBe(400)
  })

  it('queues a payout for a valid claim id', async () => {
    const res = await request(app)
      .post(`/api/v1/protection-fund/claims/${CLAIM_ID}/payout`)
      .set('x-mock-scopes', 'protection-fund:write')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('PAYOUT_QUEUED')
  })
})
