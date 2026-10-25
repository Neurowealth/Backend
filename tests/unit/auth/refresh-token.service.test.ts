/**
 * Refresh-token rotation and revocation unit tests (#472).
 *
 * The properties under test are the security ones:
 *   - a refresh token works exactly once (rotation)
 *   - a second use of the same token is treated as a leak and kills the session
 *   - revocation clears the refresh material, so nothing captured beforehand works
 *   - a revoked/expired/inactive session cannot be exchanged
 *   - the rotation write is a compare-and-swap, so concurrent refreshes cannot
 *     both win
 */

const mockSessionFindFirst = jest.fn()
const mockSessionFindUnique = jest.fn()
const mockSessionUpdate = jest.fn()
const mockSessionUpdateMany = jest.fn()
const mockCloseUserSockets = jest.fn()
const mockPublishUserEvent = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    session: {
      findFirst: (...args: unknown[]) => mockSessionFindFirst(...args),
      findUnique: (...args: unknown[]) => mockSessionFindUnique(...args),
      update: (...args: unknown[]) => mockSessionUpdate(...args),
      updateMany: (...args: unknown[]) => mockSessionUpdateMany(...args),
    },
  },
}))

jest.mock('../../../src/ws/server', () => ({
  closeUserSockets: (...args: unknown[]) => mockCloseUserSockets(...args),
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: (...args: unknown[]) => {
    mockPublishUserEvent(...args)
    return Promise.resolve()
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

import bcrypt from 'bcryptjs'
import {
  deriveRefreshTokenPrefix,
  newRefreshTokenFields,
  issueTokenPair,
  revokeSession,
  rotateRefreshToken,
} from '../../../src/services/refresh-token.service'

const HASH_ROUNDS = 4 // keep the suite fast; production uses 12

/** Build a session row as rotateRefreshToken expects to find it. */
function sessionRow(
  overrides: Partial<{
    id: string
    userId: string
    refreshTokenHash: string | null
    refreshTokenPrefix: string | null
    refreshTokenExpiresAt: Date | null
    refreshTokenUsedAt: Date | null
    refreshTokenRotations: number
    expiresAt: Date
    revokedAt: Date | null
    isActive: boolean
  }> = {}
) {
  return {
    id: 'session-1',
    userId: 'user-1',
    refreshTokenHash: null,
    refreshTokenPrefix: null,
    refreshTokenExpiresAt: null,
    refreshTokenUsedAt: null,
    refreshTokenRotations: 0,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    isActive: true,
    deviceType: 'browser',
    approxLocation: 'Unknown',
    ...overrides,
    // `user` mirrors the relation the service includes; isActive is read from
    // the caller's overrides so the inactive-user case is expressible.
    user: { id: 'user-1', isActive: overrides.isActive ?? true },
  }
}

/** Create a live session whose stored prefix/hash correspond to `raw`. */
async function liveSessionFor(
  raw: string,
  overrides: Record<string, unknown> = {}
) {
  return sessionRow({
    refreshTokenHash: await bcrypt.hash(raw, HASH_ROUNDS),
    refreshTokenPrefix: deriveRefreshTokenPrefix(raw),
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...overrides,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSessionUpdate.mockResolvedValue({})
  mockSessionUpdateMany.mockResolvedValue({ count: 1 })
  mockCloseUserSockets.mockReturnValue(0)
})

describe('deriveRefreshTokenPrefix', () => {
  it('is deterministic for the same token', () => {
    expect(deriveRefreshTokenPrefix('abc')).toBe(
      deriveRefreshTokenPrefix('abc')
    )
  })

  it('produces different prefixes for different tokens', () => {
    expect(deriveRefreshTokenPrefix('abc')).not.toBe(
      deriveRefreshTokenPrefix('abd')
    )
  })

  it('is a tagged sha256 hex digest', () => {
    expect(deriveRefreshTokenPrefix('abc')).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('never contains the raw token', () => {
    expect(deriveRefreshTokenPrefix('super-secret')).not.toContain(
      'super-secret'
    )
  })
})

describe('issueTokenPair', () => {
  it('issues a distinct access and refresh token', async () => {
    const pair = await issueTokenPair('user-1')
    expect(pair.accessToken).toBeTruthy()
    expect(pair.refreshToken).toBeTruthy()
    expect(pair.accessToken).not.toBe(pair.refreshToken)
  })

  it('expires the refresh token well after the access token', async () => {
    const pair = await issueTokenPair('user-1')
    expect(pair.refreshExpiresAt.getTime()).toBeGreaterThan(
      pair.expiresAt.getTime()
    )
  })

  it('stores a prefix consistent with the issued token', async () => {
    const pair = await issueTokenPair('user-1')
    expect(pair.refreshTokenPrefix).toBe(
      deriveRefreshTokenPrefix(pair.refreshToken)
    )
    expect(await bcrypt.compare(pair.refreshToken, pair.refreshTokenHash)).toBe(
      true
    )
  })
})

describe('newRefreshTokenFields', () => {
  it('starts unrotated', () => {
    const fields = newRefreshTokenFields({
      refreshTokenHash: 'hash',
      refreshTokenPrefix: 'sha256:abc',
      refreshExpiresAt: new Date(),
    })

    expect(fields.refreshTokenUsedAt).toBeNull()
    expect(fields.refreshTokenRotations).toBe(0)
  })
})

describe('rotateRefreshToken', () => {
  it('exchanges a valid token for a new pair', async () => {
    const raw = 'valid-refresh-token'
    mockSessionFindFirst.mockResolvedValue(await liveSessionFor(raw))

    const result = await rotateRefreshToken(raw)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.refreshToken).not.toBe(raw)
      expect(result.rotations).toBe(1)
    }
  })

  it('looks the session up by prefix, not by scanning sessions', async () => {
    const raw = 'prefix-lookup-token'
    mockSessionFindFirst.mockResolvedValue(await liveSessionFor(raw))

    await rotateRefreshToken(raw)

    expect(mockSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { refreshTokenPrefix: deriveRefreshTokenPrefix(raw) },
      })
    )
  })

  it('stamps the used-at marker so the token cannot be replayed', async () => {
    const raw = 'single-use-token'
    mockSessionFindFirst.mockResolvedValue(await liveSessionFor(raw))

    await rotateRefreshToken(raw)

    const data = (
      mockSessionUpdateMany.mock.calls[0][0] as {
        data: Record<string, unknown>
      }
    ).data
    expect(data.refreshTokenUsedAt).toBeInstanceOf(Date)
    expect(data.refreshTokenRotations).toEqual({ increment: 1 })
  })

  it('guards the rotation write on the presented prefix', async () => {
    const raw = 'cas-token'
    mockSessionFindFirst.mockResolvedValue(await liveSessionFor(raw))

    await rotateRefreshToken(raw)

    const { where } = mockSessionUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>
    }
    expect(where).toMatchObject({
      id: 'session-1',
      refreshTokenPrefix: deriveRefreshTokenPrefix(raw),
      revokedAt: null,
    })
  })

  it('returns 400 for a missing token', async () => {
    for (const bad of ['', undefined as unknown as string]) {
      const result = await rotateRefreshToken(bad)
      expect(result).toEqual({
        ok: false,
        reason: 'invalid_token',
        status: 400,
      })
    }
    expect(mockSessionFindFirst).not.toHaveBeenCalled()
  })

  it('rejects an unknown token without touching the database', async () => {
    mockSessionFindFirst.mockResolvedValue(null)

    const result = await rotateRefreshToken('never-issued')

    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' })
    expect(mockSessionUpdateMany).not.toHaveBeenCalled()
  })

  it('rejects a token whose prefix matches but whose secret does not', async () => {
    // Prefix is a lookup hint, not proof. A row that fails the bcrypt compare
    // must be refused without revoking it: refusing-with-revocation here would
    // let anyone with a guessed prefix destroy arbitrary sessions.
    mockSessionFindFirst.mockResolvedValue(
      sessionRow({
        refreshTokenPrefix: deriveRefreshTokenPrefix('right'),
        refreshTokenHash: await bcrypt.hash('right', HASH_ROUNDS),
      })
    )

    const result = await rotateRefreshToken('wrong')

    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' })
    expect(mockSessionUpdateMany).not.toHaveBeenCalled()
    expect(mockSessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects an expired refresh token', async () => {
    const raw = 'expired-token'
    mockSessionFindFirst.mockResolvedValue(
      await liveSessionFor(raw, {
        refreshTokenExpiresAt: new Date(Date.now() - 1000),
      })
    )

    const result = await rotateRefreshToken(raw)

    expect(result).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('rejects a revoked session', async () => {
    const raw = 'revoked-token'
    mockSessionFindFirst.mockResolvedValue(
      await liveSessionFor(raw, { revokedAt: new Date() })
    )

    const result = await rotateRefreshToken(raw)

    expect(result).toMatchObject({ ok: false, reason: 'session_revoked' })
  })

  it('rejects an inactive user', async () => {
    const raw = 'deactivated-token'
    mockSessionFindFirst.mockResolvedValue(
      await liveSessionFor(raw, { isActive: false })
    )

    const result = await rotateRefreshToken(raw)

    expect(result).toMatchObject({ ok: false, reason: 'user_inactive' })
  })

  it('still refreshes when only the access token has expired', async () => {
    // This is the normal case: access tokens last 15 minutes, refresh tokens 7
    // days. Refusing here would log every user out every 15 minutes.
    const raw = 'access-expired-token'
    mockSessionFindFirst.mockResolvedValue(
      await liveSessionFor(raw, { expiresAt: new Date(Date.now() - 1000) })
    )

    const result = await rotateRefreshToken(raw)

    expect(result.ok).toBe(true)
  })

  describe('reuse detection', () => {
    it('refuses a token that was already exchanged', async () => {
      const raw = 'replayed-token'
      mockSessionFindFirst.mockResolvedValue(
        await liveSessionFor(raw, {
          refreshTokenUsedAt: new Date(Date.now() - 5000),
          refreshTokenRotations: 3,
        })
      )

      const result = await rotateRefreshToken(raw)

      expect(result).toMatchObject({ ok: false, reason: 'reuse_detected' })
    })

    it('revokes the session on reuse', async () => {
      const raw = 'replayed-token'
      mockSessionFindFirst.mockResolvedValue(
        await liveSessionFor(raw, { refreshTokenUsedAt: new Date() })
      )

      await rotateRefreshToken(raw)

      expect(mockSessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-1' },
          data: expect.objectContaining({
            revokedReason: 'refresh_token_reuse',
          }),
        })
      )
    })

    it('closes the user sockets and alerts them on reuse', async () => {
      const raw = 'replayed-token'
      mockSessionFindFirst.mockResolvedValue(
        await liveSessionFor(raw, { refreshTokenUsedAt: new Date() })
      )

      await rotateRefreshToken(raw)

      expect(mockCloseUserSockets).toHaveBeenCalledWith(
        'user-1',
        'Session revoked'
      )
      expect(mockPublishUserEvent).toHaveBeenCalledWith(
        'user-1',
        'alerts',
        'security.session_revoked',
        expect.objectContaining({ reason: 'refresh_token_reuse' })
      )
    })
  })

  describe('concurrent rotation', () => {
    it('reports reuse when the swap was lost to another refresh', async () => {
      const raw = 'concurrent-token'
      mockSessionFindFirst.mockResolvedValue(await liveSessionFor(raw))
      // Lost the race: the other request already rotated and stamped used-at.
      mockSessionUpdateMany.mockResolvedValue({ count: 0 })
      mockSessionFindUnique.mockResolvedValue({
        id: 'session-1',
        refreshTokenUsedAt: new Date(),
      })

      const result = await rotateRefreshToken(raw)

      expect(result).toMatchObject({ ok: false, reason: 'reuse_detected' })
      expect(mockSessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            revokedReason: 'refresh_token_reuse',
          }),
        })
      )
    })

    it('reports a conflict when the swap lost to an unrelated change', async () => {
      const raw = 'concurrent-token-2'
      mockSessionFindFirst.mockResolvedValue(await liveSessionFor(raw))
      mockSessionUpdateMany.mockResolvedValue({ count: 0 })
      mockSessionFindUnique.mockResolvedValue({
        id: 'session-1',
        refreshTokenUsedAt: null,
      })

      const result = await rotateRefreshToken(raw)

      expect(result).toMatchObject({ ok: false, reason: 'rotation_conflict' })
      // A plain race is not evidence of compromise, so do not revoke here.
      expect(mockSessionUpdate).not.toHaveBeenCalled()
    })
  })
})

describe('revokeSession', () => {
  it('clears the refresh material so a captured token cannot be reused', async () => {
    await revokeSession('session-1', 'logout', { userId: 'user-1' })

    const data = (
      mockSessionUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data
    expect(data).toMatchObject({
      revokedReason: 'logout',
      refreshTokenHash: null,
      refreshTokenPrefix: null,
      refreshTokenUsedAt: null,
      refreshTokenExpiresAt: null,
    })
    expect(data.revokedAt).toBeInstanceOf(Date)
  })

  it('stamps a revocation reason on the row', async () => {
    await revokeSession('session-1', 'admin')
    const data = (
      mockSessionUpdate.mock.calls[0][0] as { data: { revokedReason: string } }
    ).data
    expect(data.revokedReason).toBe('admin')
  })

  it('closes sockets and publishes an alert only when a user is known', async () => {
    await revokeSession('session-1', 'logout', { userId: 'user-1' })
    expect(mockCloseUserSockets).toHaveBeenCalledTimes(1)
    expect(mockPublishUserEvent).toHaveBeenCalledTimes(1)

    jest.clearAllMocks()
    await revokeSession('session-1', 'admin')
    expect(mockCloseUserSockets).not.toHaveBeenCalled()
    expect(mockPublishUserEvent).not.toHaveBeenCalled()
  })
})
