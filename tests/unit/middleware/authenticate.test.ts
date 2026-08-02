import { Request, Response, NextFunction } from 'express'
import { Network } from '@prisma/client'
import {
  requireAuth,
  enforceUserAccess,
  AuthMiddleware,
} from '../../../src/middleware/authenticate'
import { JwtAdapter } from '../../../src/config'
import db from '../../../src/db'
import { logger } from '../../../src/utils/logger'
import { makeSession } from '../../fixtures'

jest.mock('../../../src/config')
// Explicit factory: automocking src/db can't see the PrismaClient instance's
// lazily-defined model properties (db.session would be undefined).
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    session: {
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    user: {
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
}

type AuthenticatedRequest = Partial<Request> & {
  userId?: string
  stellarPubKey?: string
  auth?: AuthPayload
  header?: any
}

describe('Authentication Middleware (Unified)', () => {
  let req: AuthenticatedRequest
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    req = {
      headers: {},
      params: {},
      body: {},
    }
    // Middleware reads headers via req.header(name); back it with req.headers
    // so tests can keep seeding plain header objects.
    req.header = jest.fn((name: string) =>
      req.headers
        ? (req.headers as Record<string, string>)[name.toLowerCase()]
        : undefined
    ) as any

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }

    next = jest.fn()
    jest.clearAllMocks()
  })

  function mockHeader(token: string) {
    req.header = jest.fn((name: string) =>
      name === 'Authorization' ? `Bearer ${token}` : undefined
    ) as any
  }

  describe('requireAuth - JWT + Session Validation', () => {
    it('should reject requests without Authorization header', async () => {
      await requireAuth(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject requests with malformed Bearer token', async () => {
      req.headers = { authorization: 'InvalidFormat token' }

      await requireAuth(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid Bearer token' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject requests with missing token after Bearer', async () => {
      req.headers = { authorization: 'Bearer ' }

      await requireAuth(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject invalid JWT signatures', async () => {
      req.headers = { authorization: 'Bearer invalid.jwt.token' }
      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue(null)

      await requireAuth(req as Request, res as Response, next)

      expect(JwtAdapter.validateToken).toHaveBeenCalledWith('invalid.jwt.token')
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject requests when session not found in database', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(null)

      await requireAuth(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject expired sessions and clean them up', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }

      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(
        makeSession(token, { expiresAt: new Date(Date.now() - 3_600_000) })
      )
      ;(db.session.delete as jest.Mock).mockResolvedValue({})

      await requireAuth(req as Request, res as Response, next)

      expect(db.session.delete).toHaveBeenCalledWith({ where: { token } })
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Session expired' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject inactive users', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }

      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(
        makeSession(token, { user: { id: 'user1', isActive: false } })
      )

      await requireAuth(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: 'User account is inactive',
      })
      expect(next).not.toHaveBeenCalled()
    })

    it('should successfully authenticate valid JWT + active session + active user', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)

      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(
        makeSession(token)
      )

      await requireAuth(req as Request, res as Response, next)

      expect(req.userId).toBe('user1')
      expect(req.stellarPubKey).toBe(
        'GDZST3XVCDTUJ76ZAV2HA72KYXM4Y5KLTMPQWLBQ3VBLGR4A5YNWHA63'
      )
      expect(req.auth).toEqual({
        userId: 'user1',
        sessionId: 'session1',
        walletAddress:
          'GDZST3XVCDTUJ76ZAV2HA72KYXM4Y5KLTMPQWLBQ3VBLGR4A5YNWHA63',
        network: Network.MAINNET,
      })
      expect(next).toHaveBeenCalled()
    })

    it('should handle JWT validation errors gracefully', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)

      const testError = new Error('JWT validation failed')
      ;(JwtAdapter.validateToken as jest.Mock).mockRejectedValue(testError)

      await requireAuth(req as Request, res as Response, next)

      expect(logger.error).toHaveBeenCalledWith(
        '[Auth] Middleware error:',
        testError
      )
      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should handle database errors gracefully', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)

      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      const dbError = new Error('Database connection failed')
      ;(db.session.findUnique as jest.Mock).mockRejectedValue(dbError)

      await requireAuth(req as Request, res as Response, next)

      expect(logger.error).toHaveBeenCalledWith(
        '[Auth] Middleware error:',
        dbError
      )
      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' })
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('enforceUserAccess - Authorization Check', () => {
    const fullAuth: AuthPayload = {
      userId: 'user1',
      sessionId: 'session1',
      walletAddress: '0x123',
      network: Network.MAINNET,
    }

    it('should reject requests without authentication', () => {
      req.auth = undefined
      req.params = { userId: 'user2' }

      enforceUserAccess(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should allow access to own user data (params)', () => {
      req.auth = fullAuth
      req.params = { userId: 'user1' }

      enforceUserAccess(req as Request, res as Response, next)

      expect(res.status).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    })

    it('should allow access to own user data (body)', () => {
      req.auth = fullAuth
      req.body = { userId: 'user1' }

      enforceUserAccess(req as Request, res as Response, next)

      expect(res.status).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    })

    it('should reject access to other user data (params)', () => {
      req.auth = fullAuth
      req.params = { userId: 'user2' }

      enforceUserAccess(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject access to other user data (body)', () => {
      req.auth = fullAuth
      req.body = { userId: 'user2' }

      enforceUserAccess(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should allow access without userId check when not specified', () => {
      req.auth = fullAuth
      req.params = {}
      req.body = {}

      enforceUserAccess(req as Request, res as Response, next)

      expect(res.status).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    })
  })

  describe('AuthMiddleware backward compatibility', () => {
    it('should have validateJwt pointing to requireAuth', () => {
      expect(AuthMiddleware.validateJwt).toBe(requireAuth)
    })

    it('should work as a middleware when used as AuthMiddleware.validateJwt', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)

      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(
        makeSession(token)
      )

      await AuthMiddleware.validateJwt(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(req.userId).toBe('user1')
    })
  })

  describe('Security Requirements', () => {
    it('should ALWAYS verify JWT signature before trusting token', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)
      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue(null)

      await requireAuth(req as Request, res as Response, next)

      expect(JwtAdapter.validateToken).toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    })

    it('should ALWAYS check DB session even if JWT is valid', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)
      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(null)

      await requireAuth(req as Request, res as Response, next)

      expect(db.session.findUnique).toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    })

    it('should ALWAYS check session expiry', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)
      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(
        makeSession(token, { expiresAt: new Date(Date.now() - 1000) })
      )
      ;(db.session.delete as jest.Mock).mockResolvedValue({})

      await requireAuth(req as Request, res as Response, next)

      expect(next).not.toHaveBeenCalled()
    })

    it('should ALWAYS check user.isActive status', async () => {
      const token = 'valid.jwt.token'
      req.headers = { authorization: `Bearer ${token}` }
      mockHeader(token)
      ;(JwtAdapter.validateToken as jest.Mock).mockResolvedValue({
        id: 'user1',
      })
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(
        makeSession(token, { user: { id: 'user1', isActive: false } })
      )

      await requireAuth(req as Request, res as Response, next)

      expect(next).not.toHaveBeenCalled()
    })
  })
})
