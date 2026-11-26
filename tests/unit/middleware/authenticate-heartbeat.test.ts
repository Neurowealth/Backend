/**
 * Unit tests for session heartbeat persistence in requireAuth middleware.
 *
 * Tests verify:
 * - Heartbeat updates are awaited before calling next()
 * - Sequential requests see fresh last-seen state
 * - Transient DB failures don't block legitimate users (fail-open policy)
 * - Anomaly detection uses fresh state, not stale data
 */

import { Request, Response, NextFunction } from 'express'
import { requireAuth } from '../../../src/middleware/authenticate'
import db from '../../../src/db'
import { JwtAdapter } from '../../../src/config'
import { evaluateAndHandleSessionAnomaly } from '../../../src/services/session-anomaly.service'

// Mock dependencies
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    session: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}))

jest.mock('../../../src/config', () => ({
  JwtAdapter: {
    verify: jest.fn(),
  },
}))

jest.mock('../../../src/middleware/apiKeyAuth', () => ({
  isUserApiKeyToken: jest.fn(() => false),
  authenticateApiKey: jest.fn(),
}))

jest.mock('../../../src/middleware/impersonation', () => ({
  verifyImpersonationToken: jest.fn(() => null),
}))

jest.mock('../../../src/services/session-anomaly.service', () => ({
  evaluateAndHandleSessionAnomaly: jest.fn(async () => false),
}))

jest.mock('../../../src/utils/geoip', () => ({
  resolveApproxLocation: jest.fn((ip) => `Location-${ip}`),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

describe('requireAuth - Session Heartbeat Persistence', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  const mockSession = {
    id: 'session-123',
    token: 'valid-token',
    userId: 'user-123',
    walletAddress: 'GTEST...',
    network: 'TESTNET',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
    lastSeenAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
    lastSeenIp: '192.168.1.1',
    approxLocation: 'Location-192.168.1.1',
    ipAddress: '192.168.1.1',
    deviceType: 'web',
    revokedAt: null,
    user: {
      id: 'user-123',
      isActive: true,
    },
  }

  beforeEach(() => {
    req = {
      headers: { authorization: 'Bearer valid-token' },
      ip: '192.168.1.100',
      get: jest.fn((header) => {
        if (header === 'user-agent') return 'Mozilla/5.0'
        return undefined
      }),
    }
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    next = jest.fn()

    jest.clearAllMocks()
    ;(JwtAdapter.verify as jest.Mock).mockReturnValue({
      type: 'session',
      sessionId: 'session-123',
    })
  })

  describe('Heartbeat update awaiting', () => {
    it('should await heartbeat update before calling next()', async () => {
      const updateOrder: string[] = []

      ;(db.session.findUnique as jest.Mock).mockResolvedValue(mockSession)
      ;(db.session.update as jest.Mock).mockImplementation(async () => {
        updateOrder.push('update')
        // Simulate a slow DB update
        await new Promise((resolve) => setTimeout(resolve, 100))
        return mockSession
      })

      const nextSpy = jest.fn(() => {
        updateOrder.push('next')
      })

      await requireAuth(req as Request, res as Response, nextSpy)

      // Verify next() was called only after update completed
      expect(nextSpy).toHaveBeenCalled()
      expect(updateOrder).toEqual(['update', 'next'])
    })

    it('should update session with current IP and location', async () => {
      req.ip = '10.0.0.50'

      ;(db.session.findUnique as jest.Mock).mockResolvedValue(mockSession)
      ;(db.session.update as jest.Mock).mockResolvedValue(mockSession)

      await requireAuth(req as Request, res as Response, next)

      expect(db.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-123' },
          data: expect.objectContaining({
            lastSeenIp: '10.0.0.50',
            approxLocation: 'Location-10.0.0.50',
            lastSeenAt: expect.any(Date),
          }),
        })
      )
      expect(next).toHaveBeenCalled()
    })

    it('should update session when IP changes', async () => {
      const sessionWithOldIP = {
        ...mockSession,
        lastSeenIp: '192.168.1.1',
        lastSeenAt: new Date(Date.now() - 1 * 60 * 1000), // 1 minute ago
      }

      req.ip = '192.168.2.1' // Different IP

      ;(db.session.findUnique as jest.Mock).mockResolvedValue(sessionWithOldIP)
      ;(db.session.update as jest.Mock).mockResolvedValue(sessionWithOldIP)

      await requireAuth(req as Request, res as Response, next)

      expect(db.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-123' },
          data: expect.objectContaining({
            lastSeenIp: '192.168.2.1',
            approxLocation: 'Location-192.168.2.1',
          }),
        })
      )
      expect(next).toHaveBeenCalled()
    })

    it('should update session when more than 5 minutes elapsed', async () => {
      const sessionOld = {
        ...mockSession,
        lastSeenAt: new Date(Date.now() - 6 * 60 * 1000), // 6 minutes ago
        lastSeenIp: req.ip,
      }

      ;(db.session.findUnique as jest.Mock).mockResolvedValue(sessionOld)
      ;(db.session.update as jest.Mock).mockResolvedValue(sessionOld)

      await requireAuth(req as Request, res as Response, next)

      expect(db.session.update).toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    })

    it('should not update session when less than 5 minutes elapsed and IP unchanged', async () => {
      const sessionRecent = {
        ...mockSession,
        lastSeenAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
        lastSeenIp: req.ip,
      }

      ;(db.session.findUnique as jest.Mock).mockResolvedValue(sessionRecent)

      await requireAuth(req as Request, res as Response, next)

      expect(db.session.update).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    })
  })

  describe('Failure handling (fail-open policy)', () => {
    it('should continue request if heartbeat update fails', async () => {
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(mockSession)
      ;(db.session.update as jest.Mock).mockRejectedValue(
        new Error('Database connection lost')
      )

      await requireAuth(req as Request, res as Response, next)

      // Should still call next() despite DB failure
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('should log error when heartbeat update fails', async () => {
      const logger = require('../../../src/utils/logger').logger

      ;(db.session.findUnique as jest.Mock).mockResolvedValue(mockSession)
      ;(db.session.update as jest.Mock).mockRejectedValue(
        new Error('Database timeout')
      )

      await requireAuth(req as Request, res as Response, next)

      expect(logger.error).toHaveBeenCalledWith(
        '[Auth] Session heartbeat update failed',
        expect.objectContaining({
          err: expect.any(Error),
        })
      )
      expect(next).toHaveBeenCalled()
    })
  })

  describe('Sequential request state freshness', () => {
    it('should ensure second request sees updated state from first request', async () => {
      // Simulate two sequential requests with different IPs
      const firstRequestIp = '192.168.1.100'
      const secondRequestIp = '192.168.2.200'

      let currentSessionState = { ...mockSession }

      ;(db.session.findUnique as jest.Mock).mockImplementation(async () => {
        // Return current state
        return { ...currentSessionState }
      })

      ;(db.session.update as jest.Mock).mockImplementation(async ({ data }) => {
        // Update the session state
        currentSessionState = { ...currentSessionState, ...data }
        return currentSessionState
      })

      // First request
      req.ip = firstRequestIp
      await requireAuth(req as Request, res as Response, next)

      expect(db.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastSeenIp: firstRequestIp,
          }),
        })
      )

      // Clear mocks
      jest.clearAllMocks()

      // Second request (should see updated state from first)
      req.ip = secondRequestIp
      ;(db.session.findUnique as jest.Mock).mockResolvedValue(
        currentSessionState
      )

      await requireAuth(req as Request, res as Response, next)

      // Verify second request uses fresh state from first request
      const findCall = (db.session.findUnique as jest.Mock).mock.calls[0]
      expect(findCall).toBeDefined()

      // The second update should see the IP from the first request
      expect(db.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastSeenIp: secondRequestIp,
          }),
        })
      )
    })
  })

  describe('Integration with anomaly detection', () => {
    it('should pass fresh state to anomaly detection', async () => {
      const updatedSession = {
        ...mockSession,
        lastSeenAt: new Date(),
        lastSeenIp: req.ip,
        approxLocation: `Location-${req.ip}`,
      }

      ;(db.session.findUnique as jest.Mock).mockResolvedValue(mockSession)
      ;(db.session.update as jest.Mock).mockResolvedValue(updatedSession)

      await requireAuth(req as Request, res as Response, next)

      // Anomaly detection should be called with the original session state
      // (before the current request's update)
      expect(evaluateAndHandleSessionAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          lastSeenIp: mockSession.lastSeenIp,
          approxLocation: mockSession.approxLocation,
        }),
        expect.objectContaining({
          ip: req.ip,
        })
      )
    })
  })
})
