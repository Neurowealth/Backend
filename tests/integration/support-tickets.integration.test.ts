const mockUserId = '11111111-1111-4111-8111-111111111111'

import request from 'supertest'
import express from 'express'

jest.mock('../../src/middleware/authenticate', () => {
  const requireAuth = jest.fn((req: any, _res: any, next: any) => {
    req.userId = mockUserId
    req.auth = {
      userId: mockUserId,
      walletAddress: 'GWALLET_USER_1',
      network: 'TESTNET',
    }
    next()
  })
  return { requireAuth }
})

jest.mock('../../src/middleware/adminAuth', () => ({
  requireAdminAuth: (req: any, _res: any, next: any) => {
    req.adminKey = { id: 'admin-1', name: 'Support Admin' }
    next()
  },
}))

jest.mock('../../src/middleware/rateLimiter', () => ({
  sensitiveRateLimiter: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const tickets = new Map<string, any>()
const messages = new Map<string, any[]>()
let ticketSeq = 0
let msgSeq = 0

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (cb: any) => {
      const tx = {
        supportTicket: {
          create: jest.fn(async ({ data }: any) => {
            const id = `10000000-0000-4000-8000-${String(++ticketSeq).padStart(12, '0')}`
            const ticket = {
              ...data,
              id,
              createdAt: new Date(),
              updatedAt: new Date(),
              resolvedAt: null,
            }
            tickets.set(id, ticket)
            messages.set(id, [])
            return ticket
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const ticket = tickets.get(where.id)
            if (!ticket) throw new Error('Ticket not found')
            Object.assign(ticket, data)
            ticket.updatedAt = new Date()
            return ticket
          }),
        },
        ticketMessage: {
          create: jest.fn(async ({ data }: any) => {
            const id = `20000000-0000-4000-8000-${String(++msgSeq).padStart(12, '0')}`
            const msg = { ...data, id, createdAt: new Date() }
            const thread = messages.get(data.ticketId) ?? []
            thread.push(msg)
            messages.set(data.ticketId, thread)
            return msg
          }),
        },
      }
      return cb(tx)
    }),
    supportTicket: {
      findMany: jest.fn(async ({ where }: any) => {
        const result = []
        for (const t of tickets.values()) {
          if (where?.userId && t.userId !== where.userId) continue
          if (where?.status && t.status !== where.status) continue
          result.push(t)
        }
        return result
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return tickets.get(where.id) ?? null
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const ticket = tickets.get(where.id)
        if (!ticket) throw new Error('Ticket not found')
        Object.assign(ticket, data)
        ticket.updatedAt = new Date()
        return ticket
      }),
    },
    ticketMessage: {
      findMany: jest.fn(async ({ where }: any) => {
        const thread = messages.get(where.ticketId) ?? []
        return thread.filter((m) => {
          if (where.internal === false && m.internal === true) return false
          return true
        })
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `20000000-0000-4000-8000-${String(++msgSeq).padStart(12, '0')}`
        const msg = { ...data, id, createdAt: new Date() }
        const thread = messages.get(data.ticketId) ?? []
        thread.push(msg)
        messages.set(data.ticketId, thread)
        return msg
      }),
    },
  },
}))

import supportTicketRouter from '../../src/routes/support-tickets'
import adminSupportTicketRouter from '../../src/routes/admin/support-tickets'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/support/tickets', supportTicketRouter)
  app.use('/api/v1/admin/support/tickets', adminSupportTicketRouter)
  return app
}

describe('Support Ticket Integration Tests', () => {
  jest.setTimeout(30000)

  beforeEach(() => {
    tickets.clear()
    messages.clear()
    ticketSeq = 0
    msgSeq = 0
  })

  it('POST /api/v1/support/tickets creates ticket + initial message', async () => {
    const app = buildApp()

    const res = await request(app).post('/api/v1/support/tickets').send({
      subject: 'Tax Report Question',
      category: 'TAX',
      body: 'How do I download my 2025 tax summary?',
    })

    expect(res.status).toBe(201)
    expect(res.body.ticket).toBeDefined()
    expect(res.body.message).toBeDefined()
    expect(res.body.ticket.category).toBe('TAX')
    expect(res.body.message.internal).toBe(false)
  })

  it('GET /api/v1/support/tickets/:id never returns internal messages', async () => {
    const app = buildApp()

    const createRes = await request(app).post('/api/v1/support/tickets').send({
      subject: 'Technical Error',
      category: 'TECHNICAL',
      body: 'API returning 500 error on endpoint',
    })

    const ticketId = createRes.body.ticket.id

    await request(app)
      .post(`/api/v1/admin/support/tickets/${ticketId}/reply`)
      .send({
        body: 'Internal note: escalated to devops team',
        internal: true,
      })

    const threadRes = await request(app).get(
      `/api/v1/support/tickets/${ticketId}`
    )

    expect(threadRes.status).toBe(200)
    expect(threadRes.body.messages).toHaveLength(1)
    expect(threadRes.body.messages.some((m: any) => m.internal === true)).toBe(
      false
    )
  })

  it('User reply on RESOLVED ticket automatically reopens it to IN_PROGRESS', async () => {
    const app = buildApp()

    const createRes = await request(app).post('/api/v1/support/tickets').send({
      subject: 'Deposit issue',
      category: 'TRANSACTION',
      body: 'Deposit missing',
    })

    const ticketId = createRes.body.ticket.id

    await request(app)
      .patch(`/api/v1/admin/support/tickets/${ticketId}`)
      .send({ status: 'RESOLVED' })

    const replyRes = await request(app)
      .post(`/api/v1/support/tickets/${ticketId}/reply`)
      .send({ body: 'Still not showing up!' })

    expect(replyRes.status).toBe(201)
    expect(replyRes.body.ticket.status).toBe('IN_PROGRESS')
  })
})
