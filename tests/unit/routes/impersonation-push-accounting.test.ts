process.env.NODE_ENV = 'test'
process.env.JWT_SEED = '0'.repeat(64)

import express from 'express'
import request from 'supertest'
import adminRouter from '../../../src/routes/admin'
import portfolioRouter from '../../../src/routes/portfolio'
import notificationsRouter from '../../../src/routes/notifications'
import { JwtAdapter } from '../../../src/config'
import {
  generateImpersonationToken,
  clearRevokedImpersonationSessionsForTests,
} from '../../../src/middleware/impersonation'

jest.mock('../../../src/services/session-anomaly.service', () => ({
  evaluateAndHandleSessionAnomaly: jest.fn().mockResolvedValue(false),
}))

const mockFindUniqueUser = jest.fn()
const mockCreateAdminAudit = jest.fn().mockResolvedValue({ id: 'audit-1' })
const mockFindUniquePush = jest.fn()
const mockCreatePush = jest.fn().mockResolvedValue({ id: 'push-1' })
const mockUpdatePush = jest.fn().mockResolvedValue({ id: 'push-1' })
const mockFindManyTx = jest.fn().mockResolvedValue([])

const testUserId = '11111111-1111-4111-8111-111111111111'
const targetUser = {
  id: testUserId,
  walletAddress: 'GA111111111111111111111111111111111111111111111111111111',
  network: 'TESTNET',
  isActive: true,
}

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: (...args: any[]) => mockFindUniqueUser(...args),
    },
    adminAuditLog: {
      create: (...args: any[]) => mockCreateAdminAudit(...args),
    },
    pushDeviceToken: {
      findUnique: (...args: any[]) => mockFindUniquePush(...args),
      create: (...args: any[]) => mockCreatePush(...args),
      update: (...args: any[]) => mockUpdatePush(...args),
    },
    transaction: {
      findMany: (...args: any[]) => mockFindManyTx(...args),
    },
    session: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if (where.token === 'valid-user-session-token') {
          return Promise.resolve({
            id: 'sess-1',
            userId: testUserId,
            walletAddress:
              'GA111111111111111111111111111111111111111111111111111111',
            network: 'TESTNET',
            expiresAt: new Date(Date.now() + 3600000),
            revokedAt: null,
            lastSeenAt: new Date(),
            lastSeenIp: '127.0.0.1',
            user: { id: testUserId, isActive: true },
          })
        }
        return Promise.resolve(null)
      }),
      delete: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      update: jest.fn().mockResolvedValue({ id: 'sess-1' }),
    },
    $transaction: jest
      .fn()
      .mockImplementation((cb: any) =>
        typeof cb === 'function'
          ? cb(require('../../../src/db').default)
          : Promise.all(cb)
      ),
  },
}))

let currentAdminRole = 'super'
let currentAdminScopes = ['super', 'admin:impersonate']

jest.mock('../../../src/middleware/adminAuth', () => {
  const actual = jest.requireActual('../../../src/middleware/adminAuth')
  return {
    ...actual,
    requireAdminAuth: (req: any, res: any, next: any) => {
      res.locals.adminAuth = {
        id: 'admin-1',
        name: 'Ops Admin',
        role: currentAdminRole,
        scopes: currentAdminScopes,
      }
      next()
    },
    requireAdminScope: (scope: string) => (req: any, res: any, next: any) => {
      const auth = res.locals.adminAuth
      if (
        !auth ||
        (!auth.scopes.includes(scope) && !auth.scopes.includes('super'))
      ) {
        return res.status(403).json({ error: 'Forbidden' })
      }
      next()
    },
  }
})

describe('Impersonation, Push Devices and Accounting Export Routes (#762)', () => {
  let app: express.Application

  beforeEach(() => {
    jest.clearAllMocks()
    clearRevokedImpersonationSessionsForTests()
    currentAdminRole = 'super'
    currentAdminScopes = ['super', 'admin:impersonate']

    mockFindUniqueUser.mockResolvedValue(targetUser)

    // Setup JwtAdapter mock
    jest
      .spyOn(JwtAdapter, 'validateToken')
      .mockImplementation(async (token: string) => {
        if (token === 'valid-user-session-token') {
          return { id: testUserId } as any
        }
        return null
      })

    app = express()
    app.use(express.json())
    app.use('/api/v1/admin', adminRouter)
    app.use('/api/v1/portfolio', portfolioRouter)
    app.use('/api/v1/notifications', notificationsRouter)
  })

  describe('POST and DELETE /api/v1/admin/impersonation', () => {
    it('starts impersonation and returns token and sessionId', async () => {
      const res = await request(app)
        .post('/api/v1/admin/impersonation')
        .send({
          targetUserId: testUserId,
          reason: 'Investigating balance query',
        })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(typeof res.body.token).toBe('string')
      expect(typeof res.body.sessionId).toBe('string')
    })

    it('rejects start impersonation if target user does not exist', async () => {
      mockFindUniqueUser.mockResolvedValueOnce(null)
      const res = await request(app)
        .post('/api/v1/admin/impersonation')
        .send({ targetUserId: '00000000-0000-0000-0000-000000000000' })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Target user not found')
    })

    it('rejects start impersonation without admin:impersonate scope', async () => {
      currentAdminRole = 'support'
      currentAdminScopes = ['support:read']

      const res = await request(app)
        .post('/api/v1/admin/impersonation')
        .send({ targetUserId: testUserId })

      expect(res.status).toBe(403)
    })

    it('ends impersonation and revokes session', async () => {
      const startRes = await request(app)
        .post('/api/v1/admin/impersonation')
        .send({ targetUserId: testUserId })

      const sessionId = startRes.body.sessionId
      const token = startRes.body.token

      // DELETE /api/v1/admin/impersonation
      const endRes = await request(app)
        .delete('/api/v1/admin/impersonation')
        .send({ sessionId })

      expect(endRes.status).toBe(200)
      expect(endRes.body.status).toBe('revoked')

      // Token should now be rejected by requireAuth because it is revoked
      const accessRes = await request(app)
        .get('/api/v1/portfolio/accounting-export?format=xero-csv')
        .set('Authorization', `Bearer ${token}`)

      expect(accessRes.status).toBe(401)
    })

    it('ends impersonation via DELETE /api/v1/admin/impersonation/:sessionId', async () => {
      const startRes = await request(app)
        .post('/api/v1/admin/impersonation')
        .send({ targetUserId: testUserId })

      const sessionId = startRes.body.sessionId

      const endRes = await request(app).delete(
        `/api/v1/admin/impersonation/${sessionId}`
      )

      expect(endRes.status).toBe(200)
      expect(endRes.body.status).toBe('revoked')
    })
  })

  describe('Write protection during impersonation sessions', () => {
    it('returns 403 on write route when called with impersonation token', async () => {
      const startRes = await request(app)
        .post('/api/v1/admin/impersonation')
        .send({ targetUserId: testUserId })

      const token = startRes.body.token

      // Attempt mutating operation: POST /notifications/push/devices
      const writeRes = await request(app)
        .post('/api/v1/notifications/push/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ token: 'device-token-123', platform: 'IOS' })

      expect(writeRes.status).toBe(403)
      expect(writeRes.body.error).toContain(
        'Write operations are not allowed during impersonation sessions'
      )

      // Attempt mutating operation: DELETE /notifications/push/devices
      const deleteRes = await request(app)
        .delete('/api/v1/notifications/push/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ token: 'device-token-123' })

      expect(deleteRes.status).toBe(403)
    })
  })

  describe('GET /api/v1/portfolio/accounting-export', () => {
    it('succeeds for user with valid format and export parameters', async () => {
      const token = generateImpersonationToken('admin-1', 'Admin', testUserId)

      const res = await request(app)
        .get('/api/v1/portfolio/accounting-export?format=xero-csv')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.headers['x-export-reconciled']).toBe('true')
    })

    it('rejects request with invalid date range', async () => {
      const token = generateImpersonationToken('admin-1', 'Admin', testUserId)

      const res = await request(app)
        .get(
          '/api/v1/portfolio/accounting-export?format=xero-csv&from=2026-05-01&to=2026-01-01'
        )
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid date range')
    })
  })

  describe('POST and DELETE /api/v1/notifications/push/devices', () => {
    it('registers a push device token successfully for authenticated user', async () => {
      mockFindUniquePush.mockResolvedValueOnce(null)

      const res = await request(app)
        .post('/api/v1/notifications/push/devices')
        .set('Authorization', 'Bearer valid-user-session-token')
        .send({ token: 'push-token-abc', platform: 'ANDROID' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.message).toBe('Device token registered successfully')
    })

    it('deregisters a push device token via route param', async () => {
      mockFindUniquePush.mockResolvedValueOnce({
        id: 'push-1',
        token: 'push-token-abc',
      })

      const res = await request(app)
        .delete('/api/v1/notifications/push/devices/push-token-abc')
        .set('Authorization', 'Bearer valid-user-session-token')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.message).toBe('Device token deregistered successfully')
    })

    it('deregisters a push device token via body', async () => {
      mockFindUniquePush.mockResolvedValueOnce({
        id: 'push-1',
        token: 'push-token-abc',
      })

      const res = await request(app)
        .delete('/api/v1/notifications/push/devices')
        .set('Authorization', 'Bearer valid-user-session-token')
        .send({ token: 'push-token-abc' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })
})
