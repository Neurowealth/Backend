process.env.NODE_ENV = 'test'

import {
  detectSessionAnomaly,
  evaluateAndHandleSessionAnomaly,
  SessionData,
} from '../../src/services/session-anomaly.service'
import { publishUserEvent } from '../../src/events/publisher'
import { closeUserSockets } from '../../src/ws/server'
import { revokeSession } from '../../src/services/refresh-token.service'

jest.mock('../../src/utils/geoip', () => ({
  ...jest.requireActual('../../src/utils/geoip'),
  resolveApproxLocation: (ip: string) =>
    (
      ({ '8.8.8.8': 'Mountain View, US', '1.1.1.1': 'Sydney, AU' }) as Record<
        string,
        string
      >
    )[ip] ?? null,
}))

jest.mock('../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../src/ws/server', () => ({
  closeUserSockets: jest.fn().mockReturnValue(1),
}))

jest.mock('../../src/services/refresh-token.service', () => ({
  revokeSession: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

describe('Session Anomaly Detection (#515)', () => {
  const baseSession: SessionData = {
    id: 'session-123',
    userId: 'user-456',
    ipAddress: '8.8.8.8',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    deviceType: 'web',
    approxLocation: 'Mountain View, US',
    lastSeenAt: new Date(Date.now() - 2 * 60 * 1000), // 2 mins ago
    lastSeenIp: '8.8.8.8',
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('detectSessionAnomaly Heuristics', () => {
    it('returns isAnomalous: false for normal request with matching location and device', () => {
      const result = detectSessionAnomaly(baseSession, {
        ip: '8.8.8.8',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })

      expect(result.isAnomalous).toBe(false)
      expect(result.heuristic).toBeUndefined()
    })

    it('detects IMPOSSIBLE_LOCATION_HOP when location changes in < 15 minutes', () => {
      const result = detectSessionAnomaly(baseSession, {
        ip: '1.1.1.1', // Resolves to 'Sydney, AU' in geoip.ts
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })

      expect(result.isAnomalous).toBe(true)
      expect(result.heuristic).toBe('IMPOSSIBLE_LOCATION_HOP')
      expect(result.details).toContain('Location changed')
    })

    it('detects SUSPICIOUS_DEVICE_TYPE_CHANGE when web session switches to CLI user-agent', () => {
      const result = detectSessionAnomaly(baseSession, {
        ip: '8.8.8.8',
        userAgent: 'python-requests/2.28.1', // DeviceType: cli
      })

      expect(result.isAnomalous).toBe(true)
      expect(result.heuristic).toBe('SUSPICIOUS_DEVICE_TYPE_CHANGE')
      expect(result.details).toContain('Device type changed mid-session')
    })

    it('detects SUBNET_JUMP_ANOMALY when IP jumps across /16 subnets within 60s', () => {
      const recentSession: SessionData = {
        ...baseSession,
        lastSeenAt: new Date(Date.now() - 5 * 1000), // 5s ago
        lastSeenIp: '198.51.100.1',
      }

      const result = detectSessionAnomaly(recentSession, {
        ip: '203.0.113.50',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })

      expect(result.isAnomalous).toBe(true)
      expect(result.heuristic).toBe('SUBNET_JUMP_ANOMALY')
      expect(result.details).toContain('Subnet jumped')
    })
  })

  describe('evaluateAndHandleSessionAnomaly Protective Flow', () => {
    it('executes forced logout, revokes session, closes sockets, and emits security event on anomaly', async () => {
      const reqContext = {
        ip: '1.1.1.1', // Trigger IMPOSSIBLE_LOCATION_HOP
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      }

      const isAnomalous = await evaluateAndHandleSessionAnomaly(
        baseSession,
        reqContext
      )

      expect(isAnomalous).toBe(true)
      expect(revokeSession).toHaveBeenCalledWith(
        'session-123',
        'session_anomaly:IMPOSSIBLE_LOCATION_HOP',
        expect.objectContaining({
          userId: 'user-456',
        })
      )
      expect(closeUserSockets).toHaveBeenCalledWith(
        'user-456',
        expect.stringContaining('IMPOSSIBLE_LOCATION_HOP')
      )
      expect(publishUserEvent).toHaveBeenCalledWith(
        'user-456',
        'alerts',
        'security.session_anomaly',
        expect.objectContaining({
          sessionId: 'session-123',
          heuristic: 'IMPOSSIBLE_LOCATION_HOP',
        })
      )
    })

    it('does nothing and returns false when session is clean', async () => {
      const reqContext = {
        ip: '8.8.8.8',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      }

      const isAnomalous = await evaluateAndHandleSessionAnomaly(
        baseSession,
        reqContext
      )

      expect(isAnomalous).toBe(false)
      expect(revokeSession).not.toHaveBeenCalled()
      expect(closeUserSockets).not.toHaveBeenCalled()
      expect(publishUserEvent).not.toHaveBeenCalled()
    })
  })
})
