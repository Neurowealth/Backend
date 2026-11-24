/**
 * GET /transactions/:id/events — IDOR fix (#757).
 *
 * Before the fix the handler loaded the transaction by id and returned every
 * transactionEvent row for it with no ownership check, so any authenticated
 * user (or key with `transactions:read`) could read another user's event
 * timeline by guessing a transaction id. It now returns 404 unless the
 * transaction belongs to the authenticated user, exactly like
 * GET /detail/:txHash in the same router.
 *
 * Follows the repo's route-test pattern (see
 * tests/unit/routes/agent-decisions.test.ts): supertest against the real
 * router, mocked `src/db`, and a mocked `requireAuth` that sets `req.auth`
 * for the caller. `requireScope` is mocked as a faithful passthrough guard
 * (it checks `req.authScopes`, as the real one does) so the tests exercise
 * the ownership check rather than scope enforcement, which is unchanged.
 */

process.env.NODE_ENV = 'test'

import express from 'express'
import request from 'supertest'
import { Request, Response, NextFunction } from 'express'
import { Network } from '@prisma/client'
import transactionsRouter from '../../../src/routes/transactions'

const mockFindUnique = jest.fn()
const mockFindEvents = jest.fn()

// The authenticated caller for the next request; tests set this per case.
let currentUserId = 'user-A'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    transaction: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
    },
    transactionEvent: {
      findMany: (...a: unknown[]) => mockFindEvents(...a),
    },
  },
}))

jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers?.authorization) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.auth = {
      userId: currentUserId,
      sessionId: 'sess-1',
      walletAddress: 'GTEST',
      network: Network.MAINNET,
    }
    // A real session grants transactions:read (see requireAuth in
    // src/middleware/authenticate.ts).
    req.authScopes = ['transactions:read']
    next()
  },
  enforceUserAccess: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}))

jest.mock('../../../src/middleware/apiKeyAuth', () => ({
  requireScope:
    (...requiredScopes: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const scopes = (req as any).authScopes ?? []
      if (
        scopes.includes('*') ||
        requiredScopes.some((s) => scopes.includes(s))
      ) {
        next()
        return
      }
      res.status(403).json({ error: 'insufficient_scope' })
    },
}))

const app = express()
app.use(express.json())
app.use('/transactions', transactionsRouter)

function authHeader() {
  return { Authorization: 'Bearer test-token' }
}

beforeEach(() => {
  jest.clearAllMocks()
  currentUserId = 'user-A'
  mockFindEvents.mockResolvedValue([])
})

describe('GET /transactions/:id/events (#757)', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/transactions/tx-1/events')
    expect(res.status).toBe(401)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it("returns 404 when the transaction belongs to another user (user A requests user B's transaction)", async () => {
    mockFindUnique.mockResolvedValue({ id: 'tx-1', userId: 'user-B' })

    const res = await request(app)
      .get('/transactions/tx-1/events')
      .set(authHeader())

    expect(res.status).toBe(404)
    // The event timeline must not leak: no event query is issued at all.
    expect(mockFindEvents).not.toHaveBeenCalled()
  })

  it('returns 404 when the transaction does not exist', async () => {
    mockFindUnique.mockResolvedValue(null)

    const res = await request(app)
      .get('/transactions/tx-1/events')
      .set(authHeader())

    expect(res.status).toBe(404)
    expect(mockFindEvents).not.toHaveBeenCalled()
  })

  it("returns the caller's own transaction events in order", async () => {
    mockFindUnique.mockResolvedValue({ id: 'tx-1', userId: 'user-A' })
    const events = [
      { id: 'ev-1', transactionId: 'tx-1', occurredAt: '2026-11-01T00:00:00Z' },
      { id: 'ev-2', transactionId: 'tx-1', occurredAt: '2026-11-02T00:00:00Z' },
    ]
    mockFindEvents.mockResolvedValue(events)

    const res = await request(app)
      .get('/transactions/tx-1/events')
      .set(authHeader())

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ transactionId: 'tx-1', events })
    expect(mockFindEvents).toHaveBeenCalledWith({
      where: { transactionId: 'tx-1' },
      orderBy: { occurredAt: 'asc' },
    })
  })
})
