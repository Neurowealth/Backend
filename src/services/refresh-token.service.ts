// src/services/refresh-token.service.ts
// Refresh-token lifecycle for wallet sessions (#472).
//
// Guarantees this module is responsible for:
//
//   1. **Rotation.** Every successful refresh issues a new refresh token and
//      invalidates the one presented. The old token can never be exchanged again.
//   2. **Replay detection.** A refresh token that has already been exchanged is
//      proof that either the client or an attacker holds a copy. Either way the
//      token family is compromised, so the whole session is revoked. Continuing to
//      serve the session would let the attacker keep refreshing after the
//      legitimate user notices and logs out.
//   3. **Revocation is durable.** Logout and revocation clear the refresh
//      material, so a revoked session can never be resurrected by a refresh
//      token that predates the revocation.
//
// Lookup strategy: a refresh token is looked up by `refreshTokenPrefix`
// (SHA-256 of the raw token, indexed) and only then bcrypt-compared against
// `refreshTokenHash`. Comparing bcrypt hashes against every live session — the
// previous approach — is O(live sessions) bcrypt operations on an unauthenticated
// endpoint, which is a denial-of-service primitive as much as a correctness bug.

import type { SessionAnomalyHeuristic } from './session-anomaly.service'
import { resolveApproxLocation } from '../utils/geoip'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import db from '../db'
import { JwtAdapter } from '../config'
import { logger } from '../utils/logger'
import { publishUserEvent } from '../events/publisher'
import { closeUserSockets } from '../ws/server'
import { invalidateAllUserCaches } from '../utils/user-cache-invalidation'

/** Refresh tokens are high-entropy random bytes, so a fast hash is the right
 *  lookup key; the bcrypt hash is what actually verifies the secret. */
export function deriveRefreshTokenPrefix(rawToken: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(rawToken).digest('hex')
}

async function hashRefreshToken(raw: string): Promise<string> {
  // Cost 12 to match the other long-lived credentials in the codebase
  // (user and admin API keys). A refresh token is worth more than either: it
  // mints access tokens for seven days.
  return bcrypt.hash(raw, 12)
}

export type RevocationReason =
  | 'logout'
  | 'user'
  | 'logout_others'
  | 'admin'
  | 'refresh_token_reuse'
  | `session_anomaly:${SessionAnomalyHeuristic}`

export type RefreshFailureReason =
  | 'invalid_token'
  | 'expired'
  | 'session_revoked'
  | 'user_inactive'
  | 'reuse_detected'
  | 'rotation_conflict'
  | 'session_anomaly_detected'

export type RefreshResult =
  | {
      ok: true
      accessToken: string
      refreshToken: string
      expiresAt: string
      refreshExpiresAt: string
      rotations: number
    }
  | { ok: false; reason: RefreshFailureReason; status: number }

export interface IssuedTokenPair {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  refreshExpiresAt: Date
}

/** Mint a new access/refresh pair and return the columns to persist. */
export async function issueTokenPair(
  userId: string
): Promise<
  IssuedTokenPair & { refreshTokenHash: string; refreshTokenPrefix: string }
> {
  const accessToken = await JwtAdapter.generateAccessToken({ id: userId })
  if (!accessToken) {
    throw new Error('Failed to generate access token')
  }

  const refreshToken = JwtAdapter.generateRefreshToken()

  return {
    accessToken,
    refreshToken,
    expiresAt: JwtAdapter.accessTokenExpiresAt(),
    refreshExpiresAt: JwtAdapter.refreshTokenExpiresAt(),
    refreshTokenHash: await hashRefreshToken(refreshToken),
    refreshTokenPrefix: deriveRefreshTokenPrefix(refreshToken),
  }
}

/**
 * Fields stored when a session is created. `refreshTokenUsedAt` starts null:
 * the token has been issued but not yet exchanged.
 */
export function newRefreshTokenFields(pair: {
  refreshTokenHash: string
  refreshTokenPrefix: string
  refreshExpiresAt: Date
}): {
  refreshTokenHash: string
  refreshTokenPrefix: string
  refreshTokenExpiresAt: Date
  refreshTokenUsedAt: Date | null
  refreshTokenRotations: number
} {
  return {
    refreshTokenHash: pair.refreshTokenHash,
    refreshTokenPrefix: pair.refreshTokenPrefix,
    refreshTokenExpiresAt: pair.refreshExpiresAt,
    refreshTokenUsedAt: null,
    refreshTokenRotations: 0,
  }
}

/**
 * Exchange a refresh token for a new pair.
 *
 * The rotation write is a compare-and-swap on the presented token's prefix:
 * `updateMany` matches on the row *and* on the prefix we verified, so two
 * concurrent refreshes with the same token cannot both win. The loser sees
 * `rotation_conflict` and retries the loop, which will then classify the token
 * as a replay and revoke the session.
 */
export async function rotateRefreshToken(
  rawToken: string,
  reqContext?: { ip?: string; userAgent?: string }
): Promise<RefreshResult> {
  if (!rawToken || typeof rawToken !== 'string') {
    return { ok: false, reason: 'invalid_token', status: 400 }
  }

  const now = new Date()
  const prefix = deriveRefreshTokenPrefix(rawToken)

  // A revoked session can still be matched here, which is deliberate: replaying
  // a token from a session the user already logged out of is exactly the signal
  // worth acting on.
  const session = await db.session.findFirst({
    where: { refreshTokenPrefix: prefix },
    include: { user: { select: { id: true, isActive: true } } },
  })

  if (!session || !session.refreshTokenHash) {
    return { ok: false, reason: 'invalid_token', status: 401 }
  }

  const matches = await bcrypt.compare(rawToken, session.refreshTokenHash)
  if (!matches) {
    // Prefix matched but the secret did not: either a hash collision
    // (impractical) or a tampered row. Refuse without touching the session.
    logger.warn('[Auth] Refresh token prefix matched but verification failed', {
      sessionId: session.id,
    })
    return { ok: false, reason: 'invalid_token', status: 401 }
  }

  if (session.revokedAt) {
    return { ok: false, reason: 'session_revoked', status: 401 }
  }

  if (reqContext) {
    const {
      evaluateAndHandleSessionAnomaly,
    } = require('./session-anomaly.service')
    const isAnomalous = await evaluateAndHandleSessionAnomaly(
      session,
      reqContext
    )
    if (isAnomalous) {
      return { ok: false, reason: 'session_anomaly_detected', status: 401 }
    }
  }

  if (!session.refreshTokenExpiresAt || session.refreshTokenExpiresAt <= now) {
    return { ok: false, reason: 'expired', status: 401 }
  }

  if (!session.user.isActive) {
    return { ok: false, reason: 'user_inactive', status: 401 }
  }

  if (session.refreshTokenUsedAt) {
    // This token was already exchanged. A second use means the token leaked.
    // Revoke the whole session: both the legitimate client and the holder of
    // the stolen token lose access, and the user re-authenticates.
    await revokeSession(session.id, 'refresh_token_reuse', {
      userId: session.userId,
      deviceType: session.deviceType,
      approxLocation: session.approxLocation,
    })

    logger.error('[Auth] Refresh token reuse detected — session revoked', {
      sessionId: session.id,
      userId: session.userId,
      firstUsedAt: session.refreshTokenUsedAt.toISOString(),
    })

    return { ok: false, reason: 'reuse_detected', status: 401 }
  }

  if (session.expiresAt <= now) {
    // The access token is gone but the refresh token is still good. That is the
    // whole point of the refresh flow, so this is not a failure.
    logger.debug('[Auth] Refreshing an expired access token', {
      sessionId: session.id,
    })
  }

  const pair = await issueTokenPair(session.userId)

  // Compare-and-swap: only rotate if the row still holds the token we verified.
  const rotated = await db.session.updateMany({
    where: { id: session.id, refreshTokenPrefix: prefix, revokedAt: null },
    data: {
      token: pair.accessToken,
      expiresAt: pair.expiresAt,
      refreshTokenHash: pair.refreshTokenHash,
      refreshTokenPrefix: pair.refreshTokenPrefix,
      refreshTokenExpiresAt: pair.refreshExpiresAt,
      refreshTokenUsedAt: now,
      refreshTokenRotations: { increment: 1 },
      lastSeenAt: now,
      ...(reqContext?.ip
        ? {
            lastSeenIp: reqContext.ip,
            approxLocation: resolveApproxLocation(reqContext.ip),
          }
        : {}),
    },
  })

  if (rotated.count === 0) {
    // Lost the race against a concurrent refresh of the same token. That other
    // request will have set refreshTokenUsedAt, so re-read and classify.
    const current = await db.session.findUnique({ where: { id: session.id } })
    if (current?.refreshTokenUsedAt) {
      await revokeSession(session.id, 'refresh_token_reuse', {
        userId: session.userId,
        deviceType: session.deviceType,
        approxLocation: session.approxLocation,
      })
      logger.error(
        '[Auth] Concurrent refresh with the same token — session revoked',
        { sessionId: session.id, userId: session.userId }
      )
      return { ok: false, reason: 'reuse_detected', status: 401 }
    }
    return { ok: false, reason: 'rotation_conflict', status: 409 }
  }

  logger.info('[Auth] Refresh token rotated', {
    sessionId: session.id,
    userId: session.userId,
    rotations: session.refreshTokenRotations + 1,
  })

  return {
    ok: true,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: pair.expiresAt.toISOString(),
    refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
    rotations: session.refreshTokenRotations + 1,
  }
}

/**
 * Revoke a session and destroy its refresh material.
 *
 * The refresh columns are cleared rather than left in place, so a refresh token
 * issued before the revocation cannot be exchanged afterwards. This is a soft
 * revoke: the row survives for `REVOKED_SESSION_RETAIN_DAYS` so the session list
 * can still show the user what was terminated.
 */
export async function revokeSession(
  sessionId: string,
  reason: RevocationReason,
  context?: {
    userId?: string
    deviceType?: string | null
    approxLocation?: string | null
  }
): Promise<void> {
  const session = await db.session.update({
    where: { id: sessionId },
    data: {
      revokedAt: new Date(),
      revokedReason: reason,
      refreshTokenHash: null,
      refreshTokenPrefix: null,
      refreshTokenUsedAt: null,
      refreshTokenExpiresAt: null,
    },
    select: { userId: true },
  })

  const targetUserId = session.userId

  if (targetUserId) {
    // Invalidate cached user state and drop live sockets on session revocation (#514)
    closeUserSockets(targetUserId, 'Session revoked')
    await invalidateAllUserCaches(targetUserId)

    publishUserEvent(targetUserId, 'alerts', 'security.session_revoked', {
      sessionId,
      reason,
      deviceType: context?.deviceType ?? null,
      approxLocation: context?.approxLocation ?? null,
      revokedAt: new Date().toISOString(),
    }).catch((err) =>
      logger.warn('[Auth] Failed to emit security.session_revoked', { err })
    )
  }
}
