import express from 'express'
import request from 'supertest'

const USER_ID = 'user-123'

interface FakeRequest {
  id: string
  userId: string
  requestedBy: string
  reason: string
  status: string
  approvedBy?: string
  approvedAt?: Date
  completedAt?: Date
}

const state: { requests: FakeRequest[]; events: string[] } = {
  requests: [],
  events: [],
}

jest.mock('../../src/db', () => {
  const count = () => jest.fn(async () => 0)
  const tx = {
    session: { count: count() },
    position: { count: count() },
    transaction: { count: count() },
    agentLog: { count: count() },
    webhookSubscription: { count: count() },
    fiatOrder: { count: count() },
    recurringDepositPlan: { count: count() },
    alertRule: { count: count() },
    savingsGoal: { count: count() },
    subAccount: { count: count() },
    publishedStrategy: { count: count() },
    strategyFollow: { count: count() },
    costBasisLot: { count: count(), updateMany: jest.fn() },
    lotDisposal: { count: count(), updateMany: jest.fn() },
    portfolioAttribution: { count: count(), updateMany: jest.fn() },
    adminAuditLog: { count: count() },
    erasureRequest: {
      update: jest.fn(async ({ where, data }: any) => {
        const row = find(where.id)
        if (!row) throw new Error('Erasure request not found')
        Object.assign(row, data)
        return { ...row }
      }),
    },
    user: {
      delete: jest.fn(async () => {
        state.events.push('user.delete')
        for (const row of state.requests) {
          if (row.userId === USER_ID) row.userId = null as any
        }
        return {}
      }),
    },
  }
  const find = (id: string) => state.requests.find((r) => r.id === id) ?? null
  return {
    __esModule: true,
    default: {
      ...tx,
      user: {
        findUnique: jest.fn(async () => ({
          id: USER_ID,
          walletAddress: 'GABC',
          email: 'u@example.com',
        })),
        delete: tx.user.delete,
      },
      adminAuditLog: { create: jest.fn(async () => ({})), count: count() },
      erasureRequest: {
        findFirst: jest.fn(
          async ({ where }: any) =>
            state.requests.find(
              (r) =>
                r.userId === where.userId && where.status.in.includes(r.status)
            ) ?? null
        ),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `req-${state.requests.length + 1}`, ...data }
          state.requests.push(row)
          return row
        }),
        findUnique: jest.fn(async ({ where }: any) => {
          const row = find(where.id)
          return row
            ? { ...row, user: { id: USER_ID, walletAddress: 'GABC' } }
            : null
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = find(where.id)!
          Object.assign(row, data)
          return { ...row }
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = find(where.id)
          if (!row) return { count: 0 }
          if (where.status && row.status !== where.status) {
            return { count: 0 }
          }
          Object.assign(row, data)
          return { count: 1 }
        }),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    },
  }
})

jest.mock('../../src/services/refresh-token.service', () => ({
  revokeSession: jest.fn(),
  revokeAllUserSessions: jest.fn(async () => {
    state.events.push('sessions.revoked')
    return 1
  }),
}))

jest.mock('../../src/middleware/rateLimiter', () => ({
  erasureRateLimiter: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn(async () => ({ sent: true })) },
}))

jest.mock('../../src/middleware/adminAuth', () => ({
  ...jest.requireActual('../../src/middleware/adminAuth'),
  requireAdminAuth: (req: any, res: any, next: any) => {
    res.locals.adminAuth = {
      id: req.header('x-admin'),
      name: req.header('x-admin'),
      role: 'SUPER',
      scopes: ['super', 'read', 'write'],
    }
    next()
  },
  requireAdminScope: () => (_req: any, _res: any, next: any) => next(),
}))

import adminRouter from '../../src/routes/admin'
import { revokeAllUserSessions } from '../../src/services/refresh-token.service'

const app = express()
app.use(express.json())
app.use('/admin', adminRouter)

const as = (admin: string) => ({ 'x-admin': admin })

async function createApprovedRequest(): Promise<string> {
  const created = await request(app)
    .post('/admin/erasure/requests')
    .set(as('alice'))
    .send({ userId: USER_ID, reason: 'GDPR Art. 17' })
  expect(created.status).toBe(201)
  const id = created.body.data.id as string

  const approved = await request(app)
    .post(`/admin/erasure/requests/${id}/approve`)
    .set(as('bob'))
  expect(approved.status).toBe(200)
  return id
}

describe('privacy erasure lifecycle guardrails', () => {
  beforeEach(() => {
    state.requests = []
    state.events = []
    jest.clearAllMocks()
  })

  it('rejects approval by the admin who requested the erasure', async () => {
    const created = await request(app)
      .post('/admin/erasure/requests')
      .set(as('alice'))
      .send({ userId: USER_ID, reason: 'GDPR Art. 17' })
    const id = created.body.data.id

    const res = await request(app)
      .post(`/admin/erasure/requests/${id}/approve`)
      .set(as('alice'))

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Self-approval/)
    expect(state.requests[0].status).toBe('PENDING')
  })

  it('rejects execution by the admin who approved it', async () => {
    const id = await createApprovedRequest()

    const res = await request(app)
      .post(`/admin/erasure/requests/${id}/execute`)
      .set(as('bob'))
      .send({ confirm: `DELETE ${USER_ID}` })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Dual control/)
    expect(state.requests[0].status).toBe('APPROVED')
    expect(revokeAllUserSessions).not.toHaveBeenCalled()
  })

  it('returns a dry-run preview and changes nothing when no confirmation is sent', async () => {
    const id = await createApprovedRequest()

    const res = await request(app)
      .post(`/admin/erasure/requests/${id}/execute`)
      .set(as('carol'))
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.dryRun).toBe(true)
    expect(res.body.data.requiredConfirmation).toBe(`DELETE ${USER_ID}`)
    expect(state.requests[0].status).toBe('APPROVED')
    expect(state.events).toEqual([])
    expect(revokeAllUserSessions).not.toHaveBeenCalled()
  })

  it('rejects a wrong typed confirmation', async () => {
    const id = await createApprovedRequest()

    const res = await request(app)
      .post(`/admin/erasure/requests/${id}/execute`)
      .set(as('carol'))
      .send({ confirm: 'DELETE someone-else' })

    expect(res.status).toBe(422)
    expect(state.requests[0].status).toBe('APPROVED')
    expect(state.events).toEqual([])
  })

  it('runs the full lifecycle, revoking sessions before deleting the user', async () => {
    const id = await createApprovedRequest()

    const res = await request(app)
      .post(`/admin/erasure/requests/${id}/execute`)
      .set(as('carol'))
      .send({ confirm: `DELETE ${USER_ID}` })

    expect(res.status).toBe(200)
    expect(res.body.dryRun).toBe(false)
    expect(res.body.data.userId).toBe(USER_ID)
    expect(state.requests[0].status).toBe('COMPLETED')
    expect(state.events).toEqual(['sessions.revoked', 'user.delete'])
    expect(revokeAllUserSessions).toHaveBeenCalledWith(USER_ID, 'admin')
  })

  it('refuses to execute a request that was never approved', async () => {
    const created = await request(app)
      .post('/admin/erasure/requests')
      .set(as('alice'))
      .send({ userId: USER_ID, reason: 'GDPR Art. 17' })

    const res = await request(app)
      .post(`/admin/erasure/requests/${created.body.data.id}/execute`)
      .set(as('carol'))
      .send({ confirm: `DELETE ${USER_ID}` })

    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/Must be APPROVED/)
    expect(state.events).toEqual([])
  })

  it('prevents overlapping executions via atomic claim transition', async () => {
    const id = await createApprovedRequest()
    let signalStarted!: () => void
    let releaseFirst!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    ;(revokeAllUserSessions as jest.Mock).mockImplementationOnce(async () => {
      state.events.push('sessions.revoked')
      signalStarted()
      await gate
      return 1
    })

    const firstExecution = request(app)
      .post(`/admin/erasure/requests/${id}/execute`)
      .set(as('carol'))
      .send({ confirm: `DELETE ${USER_ID}` })

    await started
    expect(state.requests[0].status).toBe('PROCESSING')

    const secondExecution = await request(app)
      .post(`/admin/erasure/requests/${id}/execute`)
      .set(as('dave'))
      .send({ confirm: `DELETE ${USER_ID}` })

    expect(secondExecution.status).toBe(500)
    expect(secondExecution.body.error).toMatch(/status PROCESSING/)
    expect(state.events).toEqual(['sessions.revoked'])

    releaseFirst()
    const firstResult = await firstExecution
    expect(firstResult.status).toBe(200)
    expect(state.requests[0].status).toBe('COMPLETED')
    expect(state.events).toEqual(['sessions.revoked', 'user.delete'])
  })
})
