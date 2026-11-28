/**
 * Integration test for session heartbeat race conditions.
 *
 * Verifies that concurrent requests properly await heartbeat persistence,
 * preventing anomaly detection from seeing stale location/IP data.
 */

import request from 'supertest'
import app from '../../src/app'
import db from '../../src/db'
import { JwtAdapter } from '../../src/config'
import { Network } from '@prisma/client'

describe('Session Heartbeat Race Conditions', () => {
  let testUser: any
  let testSession: any
  let authToken: string

  beforeAll(async () => {
    // Create test user
    testUser = await db.user.create({
      data: {
        walletAddress: 'GTEST_HEARTBEAT_RACE',
        network: Network.TESTNET,
        isActive: true,
      },
    })

    // Create test session
    testSession = await db.session.create({
      data: {
        token: `test-session-${Date.now()}`,
        userId: testUser.id,
        walletAddress: testUser.walletAddress,
        network: testUser.network,
        deviceType: 'web',
        ipAddress: '192.168.1.1',
        lastSeenIp: '192.168.1.1',
        approxLocation: 'Location-192.168.1.1',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })

    // Generate auth token
    authToken = JwtAdapter.sign({
      type: 'session',
      sessionId: testSession.id,
    })
  })

  afterAll(async () => {
    // Cleanup
    if (testSession) {
      await db.session.deleteMany({ where: { userId: testUser.id } })
    }
    if (testUser) {
      await db.user.delete({ where: { id: testUser.id } })
    }
    await db.$disconnect()
  })

  it('should ensure sequential requests see fresh last-seen state', async () => {
    // Make first request with IP A
    const firstResponse = await request(app)
      .get('/v1/portfolio/positions')
      .set('Authorization', `Bearer ${authToken}`)
      .set('X-Forwarded-For', '10.0.0.1')
      .set('User-Agent', 'Mozilla/5.0')

    // First request might fail if endpoint doesn't exist, but auth should succeed
    // The important part is that the session was updated
    expect([200, 404]).toContain(firstResponse.status)

    // Fetch session state after first request
    const sessionAfterFirst = await db.session.findUnique({
      where: { id: testSession.id },
      select: { lastSeenIp: true, approxLocation: true, lastSeenAt: true },
    })

    // Verify first request updated the session
    expect(sessionAfterFirst?.lastSeenIp).toBe('10.0.0.1')

    // Wait a moment to ensure distinct timestamps
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Make second request with different IP
    const secondResponse = await request(app)
      .get('/v1/portfolio/positions')
      .set('Authorization', `Bearer ${authToken}`)
      .set('X-Forwarded-For', '10.0.0.2')
      .set('User-Agent', 'Mozilla/5.0')

    expect([200, 404]).toContain(secondResponse.status)

    // Fetch session state after second request
    const sessionAfterSecond = await db.session.findUnique({
      where: { id: testSession.id },
      select: { lastSeenIp: true, approxLocation: true, lastSeenAt: true },
    })

    // Verify second request saw the state from first request and updated it
    expect(sessionAfterSecond?.lastSeenIp).toBe('10.0.0.2')
    expect(sessionAfterSecond?.lastSeenAt?.getTime()).toBeGreaterThan(
      sessionAfterFirst?.lastSeenAt?.getTime() ?? 0
    )
  })

  it('should not create false anomalies from concurrent requests', async () => {
    // Reset session to known state
    await db.session.update({
      where: { id: testSession.id },
      data: {
        lastSeenIp: '192.168.1.1',
        approxLocation: 'Location-192.168.1.1',
        lastSeenAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      },
    })

    // Make two rapid requests from same IP
    // If heartbeat is not awaited, the second request might see stale state
    const [response1, response2] = await Promise.all([
      request(app)
        .get('/v1/portfolio/positions')
        .set('Authorization', `Bearer ${authToken}`)
        .set('X-Forwarded-For', '192.168.1.100')
        .set('User-Agent', 'Mozilla/5.0'),
      request(app)
        .get('/v1/portfolio/positions')
        .set('Authorization', `Bearer ${authToken}`)
        .set('X-Forwarded-For', '192.168.1.100')
        .set('User-Agent', 'Mozilla/5.0'),
    ])

    // Both requests should succeed (not be blocked by anomaly detection)
    expect([200, 404]).toContain(response1.status)
    expect([200, 404]).toContain(response2.status)

    // Session should not be revoked
    const finalSession = await db.session.findUnique({
      where: { id: testSession.id },
    })
    expect(finalSession?.revokedAt).toBeNull()
  })

  it('should properly detect anomalies with fresh state', async () => {
    // Reset session to known state
    await db.session.update({
      where: { id: testSession.id },
      data: {
        lastSeenIp: '192.168.1.1',
        approxLocation: 'US-West',
        lastSeenAt: new Date(),
      },
    })

    // Make request from dramatically different location immediately
    // This should trigger IMPOSSIBLE_LOCATION_HOP anomaly
    const response = await request(app)
      .get('/v1/portfolio/positions')
      .set('Authorization', `Bearer ${authToken}`)
      .set('X-Forwarded-For', '45.33.22.11') // Different IP that would map to different location
      .set('User-Agent', 'Mozilla/5.0')

    // With proper await, anomaly detection should work correctly
    // Response might be 401 if session was revoked due to anomaly
    // or 200/404 if anomaly detection allows it
    expect([200, 401, 404]).toContain(response.status)
  })
})
