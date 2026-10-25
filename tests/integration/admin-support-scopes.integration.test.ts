import express from 'express'
import request from 'supertest'
let mockScopes: string[] = []
let mockAuthenticated = true
jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    supportTicket: { findMany: jest.fn(async () => []) },
    adminAuditLog: { create: jest.fn(async () => ({})) },
  },
}))
jest.mock('../../src/middleware/adminAuth', () => ({
  ...jest.requireActual('../../src/middleware/adminAuth'),
  requireAdminAuth: (_req: any, res: any, next: any) => {
    if (!mockAuthenticated) return res.sendStatus(401)
    res.locals.adminAuth = {
      id: 'admin',
      name: 'Support',
      role: 'ADMIN',
      scopes: mockScopes,
    }
    next()
  },
}))
import router from '../../src/routes/admin/support-tickets'
import db from '../../src/db'
const app = express()
app.use(express.json())
app.use('/tickets', router)
describe('support admin scope enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthenticated = true
    mockScopes = []
  })
  it('rejects unauthenticated access', async () => {
    mockAuthenticated = false
    expect((await request(app).get('/tickets')).status).toBe(401)
    expect(db.supportTicket.findMany).not.toHaveBeenCalled()
  })
  it('does not grant access through generic admin read or write scopes', async () => {
    mockScopes = ['read', 'write']
    expect((await request(app).get('/tickets')).status).toBe(403)
    expect(db.supportTicket.findMany).not.toHaveBeenCalled()
  })
  it('allows support reads but rejects mutations with read-only scope', async () => {
    mockScopes = ['support:read']
    expect((await request(app).get('/tickets')).status).toBe(200)
    expect(
      (
        await request(app)
          .patch('/tickets/11111111-1111-4111-8111-111111111111')
          .send({ status: 'RESOLVED' })
      ).status
    ).toBe(403)
  })
  it('permits super-scoped support reads', async () => {
    mockScopes = ['super']
    expect((await request(app).get('/tickets')).status).toBe(200)
  })
})
