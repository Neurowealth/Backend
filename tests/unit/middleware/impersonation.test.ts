import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { verifyImpersonationToken } from '../../../src/middleware/impersonation'

describe('impersonation token secret hardening', () => {
  it('rejects tokens signed with the former hardcoded fallback secret', () => {
    const now = new Date()
    const token = jwt.sign(
      {
        adminId: 'admin_123',
        adminName: 'Admin',
        targetUserId: 'user_456',
        sessionId: crypto.randomUUID(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      'impersonation-secret',
      { expiresIn: '30m' }
    )

    expect(verifyImpersonationToken(token)).toBeNull()
  })
})
