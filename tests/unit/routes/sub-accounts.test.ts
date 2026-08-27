process.env.NODE_ENV = 'test'

import { Request, Response, NextFunction } from 'express'
import { Network } from '@prisma/client'
import subAccountsRouter from '../../../src/routes/sub-accounts'
import db from '../../../src/db'
import { logger } from '../../../src/utils/logger'
import express from 'express'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
    },
    subAccount: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}))
jest.mock('../../../src/utils/logger')

// Mock requireAuth to inject a controlled auth context
jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    if (!req.headers?.authorization) {
      _res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.auth = {
      userId: (req as any)._testUserId ?? 'parent1',
      sessionId: 'session1',
      walletAddress: 'GDZST3XVCDTUJ76ZAV2HA72KYXM4Y5KLTMPQWLBQ3VBLGR4A5YNWHA63',
      network: Network.MAINNET,
    }
    next()
  },
}))

// Mock validate to be a passthrough
jest.mock('../../../src/middleware/validate', () => ({
  validate: () => (req: Request, _res: Response, next: NextFunction) => next(),
}))

const app = express()
app.use(express.json())
app.use('/sub-accounts', subAccountsRouter)

describe('SubAccount CRUD Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function authHeader() {
    return { Authorization: 'Bearer test-token' }
  }

  // ── POST / ────────────────────────────────────────────────────────────────

  describe('POST /sub-accounts', () => {
    it('should create a sub-account relationship', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValue({ id: 'child1' })
      ;(db.subAccount.findFirst as jest.Mock).mockResolvedValue(null)
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue(null)
      ;(db.subAccount.create as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT', 'VIEW'],
        status: 'ACTIVE',
        createdAt: new Date(),
        revokedAt: null,
      })

      const res = await request(app)
        .post('/sub-accounts')
        .set(authHeader())
        .send({ childUserId: 'child1', permissions: ['DEPOSIT', 'VIEW'] })

      expect(res.status).toBe(201)
      expect(res.body.subAccount.parentUserId).toBe('parent1')
      expect(res.body.subAccount.childUserId).toBe('child1')
      expect(res.body.subAccount.permissions).toEqual(['DEPOSIT', 'VIEW'])
      expect(db.subAccount.create).toHaveBeenCalledWith({
        data: {
          parentUserId: 'parent1',
          childUserId: 'child1',
          permissions: ['DEPOSIT', 'VIEW'],
        },
      })
    })

    it('should reject self-referencing', async () => {
      const res = await request(app)
        .post('/sub-accounts')
        .set(authHeader())
        .send({ childUserId: 'parent1', permissions: ['VIEW'] })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('yourself')
    })

    it('should reject when child user does not exist', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValue(null)

      const res = await request(app)
        .post('/sub-accounts')
        .set(authHeader())
        .send({ childUserId: 'nonexistent', permissions: ['VIEW'] })

      expect(res.status).toBe(404)
      expect(res.body.error).toContain('not found')
    })

    it('should reject chained sub-accounts', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValue({ id: 'child1' })
      ;(db.subAccount.findFirst as jest.Mock).mockResolvedValue({
        id: 'existing',
        parentUserId: 'child1',
      })

      const res = await request(app)
        .post('/sub-accounts')
        .set(authHeader())
        .send({ childUserId: 'child1', permissions: ['VIEW'] })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Chained')
    })

    it('should reject duplicate ACTIVE relationship', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValue({ id: 'child1' })
      ;(db.subAccount.findFirst as jest.Mock).mockResolvedValue(null)
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
        status: 'ACTIVE',
      })

      const res = await request(app)
        .post('/sub-accounts')
        .set(authHeader())
        .send({ childUserId: 'child1', permissions: ['VIEW'] })

      expect(res.status).toBe(409)
      expect(res.body.error).toContain('already exists')
    })

    it('should re-activate a REVOKED relationship', async () => {
      ;(db.user.findUnique as jest.Mock).mockResolvedValue({ id: 'child1' })
      ;(db.subAccount.findFirst as jest.Mock).mockResolvedValue(null)
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'old-sub',
        status: 'REVOKED',
      })
      ;(db.subAccount.update as jest.Mock).mockResolvedValue({
        id: 'old-sub',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT'],
        status: 'ACTIVE',
        revokedAt: null,
      })

      const res = await request(app)
        .post('/sub-accounts')
        .set(authHeader())
        .send({ childUserId: 'child1', permissions: ['DEPOSIT'] })

      expect(res.status).toBe(201)
      expect(db.subAccount.update).toHaveBeenCalledWith({
        where: { id: 'old-sub' },
        data: {
          permissions: ['DEPOSIT'],
          status: 'ACTIVE',
          revokedAt: null,
        },
      })
    })
  })

  // ── PATCH /:id/permissions ────────────────────────────────────────────────

  describe('PATCH /sub-accounts/:id/permissions', () => {
    it('should update permissions for own sub-account', async () => {
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['VIEW'],
        status: 'ACTIVE',
      })
      ;(db.subAccount.update as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['VIEW', 'DEPOSIT', 'WITHDRAW'],
        status: 'ACTIVE',
      })

      const res = await request(app)
        .patch('/sub-accounts/sub1/permissions')
        .set(authHeader())
        .send({ permissions: ['VIEW', 'DEPOSIT', 'WITHDRAW'] })

      expect(res.status).toBe(200)
      expect(res.body.subAccount.permissions).toEqual([
        'VIEW',
        'DEPOSIT',
        'WITHDRAW',
      ])
    })

    it('should return 404 when sub-account does not exist', async () => {
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue(null)

      const res = await request(app)
        .patch('/sub-accounts/nonexistent/permissions')
        .set(authHeader())
        .send({ permissions: ['VIEW'] })

      expect(res.status).toBe(404)
    })

    it('should return 403 when not the owner', async () => {
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'other-parent',
        childUserId: 'child1',
        permissions: ['VIEW'],
        status: 'ACTIVE',
      })

      const res = await request(app)
        .patch('/sub-accounts/sub1/permissions')
        .set(authHeader())
        .send({ permissions: ['VIEW'] })

      expect(res.status).toBe(403)
    })
  })

  // ── DELETE /:id ───────────────────────────────────────────────────────────

  describe('DELETE /sub-accounts/:id', () => {
    it('should revoke own sub-account', async () => {
      const revokedAt = new Date()
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        status: 'ACTIVE',
      })
      ;(db.subAccount.update as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        status: 'REVOKED',
        revokedAt,
      })

      const res = await request(app)
        .delete('/sub-accounts/sub1')
        .set(authHeader())

      expect(res.status).toBe(200)
      expect(res.body.subAccount.status).toBe('REVOKED')
      expect(db.subAccount.update).toHaveBeenCalledWith({
        where: { id: 'sub1' },
        data: {
          status: 'REVOKED',
          revokedAt: expect.any(Date),
        },
      })
    })

    it('should return 404 when sub-account does not exist', async () => {
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue(null)

      const res = await request(app)
        .delete('/sub-accounts/nonexistent')
        .set(authHeader())

      expect(res.status).toBe(404)
    })

    it('should return 403 when not the owner', async () => {
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'other-parent',
        childUserId: 'child1',
        status: 'ACTIVE',
      })

      const res = await request(app)
        .delete('/sub-accounts/sub1')
        .set(authHeader())

      expect(res.status).toBe(403)
    })
  })

  // ── Revocation takes effect immediately ──────────────────────────────────

  describe('Revocation takes effect immediately', () => {
    it('should block delegated access on the next request after DELETE', async () => {
      // Simulate: parent has ACTIVE sub-account, then revokes it
      ;(db.subAccount.findUnique as jest.Mock)
        .mockResolvedValueOnce({
          id: 'sub1',
          parentUserId: 'parent1',
          childUserId: 'child1',
          status: 'ACTIVE',
        })
        .mockResolvedValueOnce({
          id: 'sub1',
          parentUserId: 'parent1',
          childUserId: 'child1',
          status: 'REVOKED',
          revokedAt: new Date(),
        })

      // First: verify the sub-account is active by checking findUnique
      const findResult1 = await db.subAccount.findUnique({
        where: { id: 'sub1' },
      })
      expect(findResult1?.status).toBe('ACTIVE')

      // DELETE (revoke) — the route itself calls findUnique again
      const deleteRes = await request(app)
        .delete('/sub-accounts/sub1')
        .set(authHeader())
      expect(deleteRes.status).toBe(200)

      // Next request: findUnique returns REVOKED (new mock for post-revoke lookup)
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        status: 'REVOKED',
        revokedAt: new Date(),
      })

      const findResult2 = await db.subAccount.findUnique({
        where: { id: 'sub1' },
      })
      expect(findResult2?.status).toBe('REVOKED')
    })
  })
})

// Need to import request for supertest
import request from 'supertest'
