import { FIXTURE_USER_1 } from './users'

export const FIXTURE_SESSION_VALID = {
  id: 'session1',
  userId: FIXTURE_USER_1.id,
  token: 'valid-fixture-token',
  walletAddress: FIXTURE_USER_1.walletAddress,
  network: 'MAINNET' as const,
  expiresAt: new Date('2099-12-31T23:59:59Z'),
  ipAddress: '127.0.0.1',
  userAgent: 'jest-test-agent',
  createdAt: new Date('2024-01-01T00:00:00Z'),
  user: { id: FIXTURE_USER_1.id, isActive: true },
}

export const FIXTURE_SESSION_EXPIRED = {
  id: 'session-expired-1',
  userId: FIXTURE_USER_1.id,
  token: 'expired-fixture-token',
  walletAddress: FIXTURE_USER_1.walletAddress,
  network: 'MAINNET' as const,
  expiresAt: new Date('2020-01-01T00:00:00Z'),
  ipAddress: '127.0.0.1',
  userAgent: 'jest-test-agent',
  createdAt: new Date('2020-01-01T00:00:00Z'),
  user: { id: FIXTURE_USER_1.id, isActive: true },
}

export function makeSession(
  token: string,
  overrides: Record<string, unknown> = {}
) {
  return { ...FIXTURE_SESSION_VALID, token, ...overrides }
}
