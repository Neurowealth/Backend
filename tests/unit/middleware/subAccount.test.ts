import { Request, Response, NextFunction } from 'express'
import { Network } from '@prisma/client'
import { requireSubAccountPermission } from '../../../src/middleware/subAccount'
import db from '../../../src/db'
import { logger } from '../../../src/utils/logger'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    subAccount: {
      findUnique: jest.fn(),
    },
  },
}))
jest.mock('../../../src/utils/logger')

type AuthPayload = {
  userId: string
  sessionId: string
  walletAddress: string
  network: Network
  actingAsUserId?: string
}

type AuthenticatedRequest = Partial<Request> & {
  userId?: string
  stellarPubKey?: string
  auth?: AuthPayload
  params?: Record<string, string>
  body?: Record<string, unknown>
}

describe('requireSubAccountPermission Middleware', () => {
  let req: AuthenticatedRequest
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    req = {
      headers: {},
      params: {},
      body: {},
    }
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    next = jest.fn()
    jest.clearAllMocks()
  })

  function makeAuth(userId: string): AuthPayload {
    return {
      userId,
      sessionId: 'session1',
      walletAddress: 'GDZST3XVCDTUJ76ZAV2HA72KYXM4Y5KLTMPQWLBQ3VBLGR4A5YNWHA63',
      network: Network.MAINNET,
    }
  }

  describe('self-access passthrough', () => {
    it('should allow self-access via body.userId without DB lookup', async () => {
      req.auth = makeAuth('user1')
      req.body = { userId: 'user1' }

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(db.subAccount.findUnique).not.toHaveBeenCalled()
      expect(req.auth.actingAsUserId).toBeUndefined()
    })

    it('should allow self-access via params.userId without DB lookup', async () => {
      req.auth = makeAuth('user1')
      req.params = { userId: 'user1' }

      const middleware = requireSubAccountPermission('WITHDRAW')
      await middleware(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(db.subAccount.findUnique).not.toHaveBeenCalled()
    })

    it('should allow access when no target userId is specified', async () => {
      req.auth = makeAuth('user1')
      req.body = {}
      req.params = {}

      const middleware = requireSubAccountPermission('VIEW')
      await middleware(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(db.subAccount.findUnique).not.toHaveBeenCalled()
    })
  })

  describe('delegated access - happy path', () => {
    it('should allow access with valid ACTIVE sub-account and required permission', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT', 'VIEW'],
        status: 'ACTIVE',
      })

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)

      expect(db.subAccount.findUnique).toHaveBeenCalledWith({
        where: {
          parentUserId_childUserId: {
            parentUserId: 'parent1',
            childUserId: 'child1',
          },
        },
      })
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(req.auth.actingAsUserId).toBe('parent1')
      expect(logger.info).toHaveBeenCalledWith(
        '[SubAccount] Delegated access granted',
        expect.objectContaining({
          parentUserId: 'parent1',
          childUserId: 'child1',
          permission: 'DEPOSIT',
        })
      )
    })

    it('should read target userId from params when body is absent', async () => {
      req.auth = makeAuth('parent1')
      req.params = { userId: 'child1' }
      req.body = {}

      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['WITHDRAW'],
        status: 'ACTIVE',
      })

      const middleware = requireSubAccountPermission('WITHDRAW')
      await middleware(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(req.auth.actingAsUserId).toBe('parent1')
    })
  })

  describe('delegated access - denial paths', () => {
    it('should reject when no sub-account relationship exists', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue(null)

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
      expect(next).not.toHaveBeenCalled()
      expect(req.auth.actingAsUserId).toBeUndefined()
    })

    it('should reject when sub-account status is REVOKED', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT'],
        status: 'REVOKED',
        revokedAt: new Date(),
      })

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject when permission is not in the granted set', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['VIEW'],
        status: 'ACTIVE',
      })

      const middleware = requireSubAccountPermission('WITHDRAW')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        required: 'WITHDRAW',
      })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject when sub-account row is for a different parent', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      // The findUnique uses the composite key, so if the row doesn't exist
      // for this parent-child pair, it returns null
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue(null)

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('revocation takes effect immediately', () => {
    it('should block access on the very next request after revocation', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      // First call: ACTIVE
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT'],
        status: 'ACTIVE',
      })

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)
      expect(next).toHaveBeenCalledTimes(1)

      // Second call: REVOKED (simulates revocation happened between requests)
      jest.clearAllMocks()
      next = jest.fn()
      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT'],
        status: 'REVOKED',
        revokedAt: new Date(),
      })

      await middleware(req as Request, res as Response, next)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('permissions are independent flags', () => {
    it('should not grant WITHDRAW when only DEPOSIT is granted', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT'],
        status: 'ACTIVE',
      })

      const middleware = requireSubAccountPermission('WITHDRAW')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('should not grant MANAGE_STRATEGY when DEPOSIT and VIEW are granted', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      ;(db.subAccount.findUnique as jest.Mock).mockResolvedValue({
        id: 'sub1',
        parentUserId: 'parent1',
        childUserId: 'child1',
        permissions: ['DEPOSIT', 'VIEW'],
        status: 'ACTIVE',
      })

      const middleware = requireSubAccountPermission('MANAGE_STRATEGY')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should return 500 on database errors', async () => {
      req.auth = makeAuth('parent1')
      req.body = { userId: 'child1' }

      const dbError = new Error('Database connection failed')
      ;(db.subAccount.findUnique as jest.Mock).mockRejectedValue(dbError)

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)

      expect(logger.error).toHaveBeenCalledWith(
        '[SubAccount] Middleware error:',
        dbError
      )
      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject when req.auth is missing (defensive)', async () => {
      req.auth = undefined
      req.body = { userId: 'child1' }

      const middleware = requireSubAccountPermission('DEPOSIT')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
      expect(next).not.toHaveBeenCalled()
    })
  })
})
