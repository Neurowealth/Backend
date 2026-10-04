// src/controllers/auth-controller.ts
// #214 – adds refresh token rotation; updates verify() and logout()
// #472 – refresh rotation, replay detection and durable revocation live in
//        services/refresh-token.service.ts; this controller is HTTP glue only.
// #2FA – adds TOTP second-factor challenge step after wallet-signature
//        verification; enrollment/disable live in services/totp.service.ts.
import { Request, Response } from 'express'
import { randomBytes } from 'crypto'
import { Keypair } from '@stellar/stellar-sdk'
import { JwtAdapter, config } from '../config'
import { logger } from '../utils/logger'
import db from '../db'
import { stellarVerification } from '../utils/stellar/stellar-verification'
import { attributeSignup } from '../referral/service'
import { parseDeviceType } from '../utils/deviceType'
import { resolveApproxLocation } from '../utils/geoip'
import { createSessionDeepLinkToken } from '../utils/sessionDeepLink'
import { publishUserEvent } from '../events/publisher'
import {
  issueTokenPair,
  newRefreshTokenFields,
  revokeSession,
  rotateRefreshToken,
  type RefreshFailureReason,
} from '../services/refresh-token.service'
import { getActiveTotpCredential, issueTotpChallenge } from '../services/totp.service'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Maps service-level failure reasons onto the codes clients already handle. */
const REFRESH_ERRORS: Record<
  RefreshFailureReason,
  { status: number; error: string }
> = {
  invalid_token: { status: 401, error: 'Invalid or expired refresh token' },
  expired: { status: 401, error: 'Invalid or expired refresh token' },
  session_revoked: { status: 401, error: 'Session revoked' },
  user_inactive: { status: 401, error: 'User account is inactive' },
  reuse_detected: {
    status: 401,
    // Deliberately identical to the generic failure: telling a caller that we
    // detected reuse confirms the token is real, which is a free oracle.
    error: 'Invalid or expired refresh token',
  },
  rotation_conflict: {
    status: 409,
    error: 'Concurrent refresh detected, retry',
  },
}

// ── Controllers ────────────────────────────────────────────────────────────

/**
 * POST /api/auth/challenge
 */
export async function challenge(req: Request, res: Response): Promise<void> {
  const { stellarPubKey } = req.body as { stellarPubKey: string }

  try {
    Keypair.fromPublicKey(stellarPubKey)
  } catch {
    res.status(400).json({ error: 'Invalid Stellar public key' })
    return
  }

  const nonce = `nw-auth-${randomBytes(32).toString('hex')}`
  const expiresAt = new Date(Date.now() + config.jwt.nonce_ttl_ms)

  await db.authNonce.upsert({
    where: { stellarPubKey },
    update: { nonce, expiresAt },
    create: { stellarPubKey, nonce, expiresAt },
  })

  logger.info(`[Auth] Challenge issued for ${stellarPubKey}`)
  res.status(200).json({ nonce, expiresAt: expiresAt.toISOString() })
}

/**
 * POST /api/auth/verify
 *
 * Returns:
 *   { accessToken, refreshToken, userId, expiresAt, refreshExpiresAt }
 *
 * #214: Issues a short-lived access token (15 min) and a long-lived refresh
 * token (7 days). The refresh token is stored as a bcrypt hash in the Session
 * row so it is single-use and verifiable without storing plaintext.
 */
export async function verify(req: Request, res: Response): Promise<void> {
  const { stellarPubKey, signature, referralCode } = req.body as {
    stellarPubKey: string
    signature: string
    referralCode?: string
  }

  const stored = await db.authNonce.findUnique({ where: { stellarPubKey } })
  if (!stored) {
    res.status(401).json({ error: 'No active challenge for this public key' })
    return
  }

  if (stored.expiresAt <= new Date()) {
    await db.authNonce.delete({ where: { stellarPubKey } })
    res.status(401).json({ error: 'Challenge nonce has expired' })
    return
  }

  const isValid = stellarVerification.verifyStellarSignature(
    stellarPubKey,
    stored.nonce,
    signature
  )
  if (!isValid) {
    res.status(401).json({ error: 'Invalid signature' })
    return
  }

  await db.authNonce.delete({ where: { stellarPubKey } })

  const network = stellarVerification.resolveNetwork()

  try {
    let user = await db.user.findUnique({
      where: { walletAddress: stellarPubKey },
    })

    if (!user) {
      user = await db.user.create({
        data: {
          walletAddress: stellarPubKey,
          network,
          positions: {
            create: {
              protocolName: 'unassigned',
              assetSymbol: 'USDC',
              depositedAmount: 0,
              currentValue: 0,
            },
          },
        },
      })
      logger.info(`[Auth] New user created: ${user.id} (${stellarPubKey})`)

      // Referral attribution at the source — only for brand-new users. Never
      // fails signup: invalid/self/duplicate codes are ignored inside the call.
      if (referralCode) {
        try {
          await attributeSignup(user.id, referralCode)
        } catch (err) {
          logger.error(
            '[Auth] Referral attribution failed (signup unaffected):',
            err
          )
        }
      }
    }

    // #2FA – additive second factor. If the user has an active, verified
    // TotpCredential, do NOT issue a session yet: hand back a short-lived
    // challenge that must be completed at POST /api/auth/2fa/verify. Wallet
    // signature remains factor one; TOTP is factor two.
    const totp = await getActiveTotpCredential(user.id)
    if (totp) {
      const challenge = await issueTotpChallenge(user.id, {
        stellarPubKey,
        referralCode,
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: req.ip ?? null,
      })
      logger.info(`[Auth] TOTP challenge issued for user ${user.id}`)
      res.status(200).json({
        requiresTotp: true,
        totpChallengeToken: challenge.token,
        totpExpiresAt: challenge.expiresAt.toISOString(),
      })
      return
    }

    // #472 – short-lived access token + long-lived opaque refresh token, both
    // issued through the service so the stored shape cannot drift from what
    // rotation expects to find.
    const pair = await issueTokenPair(user.id)

    const userAgent = req.headers['user-agent'] ?? null
    const ipAddress = req.ip ?? null
    const deviceType = parseDeviceType(userAgent)
    const approxLocation = resolveApproxLocation(ipAddress)

    const session = await db.session.create({
      data: {
        userId: user.id,
        token: pair.accessToken,
        walletAddress: stellarPubKey,
        network,
        expiresAt: pair.expiresAt,
        ipAddress,
        userAgent,
        deviceType,
        approxLocation,
        lastSeenAt: new Date(),
        lastSeenIp: ipAddress,
        ...newRefreshTokenFields(pair),
      },
    })

    logger.info(`[Auth] Session created for user ${user.id}`)

    const deepLinkToken = createSessionDeepLinkToken(user.id, session.id)
    publishUserEvent(user.id, 'alerts', 'security.new_session', {
      sessionId: session.id,
      deviceType,
      approxLocation,
      ipAddress: ipAddress ? `${ipAddress.slice(0, -3)}xxx` : null,
      createdAt: session.createdAt.toISOString(),
      revokeLink: `/sessions?highlight=${session.id}&token=${deepLinkToken}`,
    }).catch((err) =>
      logger.warn('[Auth] Failed to emit security.new_session', { err })
    )

    res.status(200).json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken, // returned ONCE — not stored in plaintext
      userId: user.id,
      expiresAt: pair.expiresAt.toISOString(),
      refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
    })
  } catch (error) {
    logger.error('[Auth] Verify error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * POST /api/auth/2fa/verify
 *
 * Body: { totpChallengeToken: string, code: string }
 *
 * Completes a login that was paused at the TOTP step. The wallet signature has
 * already been verified when the challenge was issued; this endpoint only
 * proves possession of the second factor. On success the session is created
 * exactly as in verify(), so downstream behaviour (session list, notifications)
 * is identical.
 */
export async function verifyTotp(req: Request, res: Response): Promise<void> {
  const { totpChallengeToken, code } = req.body as {
    totpChallengeToken?: unknown
    code?: unknown
  }

  if (typeof totpChallengeToken !== 'string' || totpChallengeToken.length === 0) {
    res.status(400).json({ error: 'totpChallengeToken is required' })
    return
  }
  if (typeof code !== 'string' || code.length === 0) {
    res.status(400).json({ error: 'code is required' })
    return
  }

  try {
    const result = await completeTotpChallenge(totpChallengeToken, code)
    if (!result.ok) {
      // Generic message: distinguishing "wrong code" from "expired challenge"
      // gives an attacker a free oracle on challenge validity.
      res.status(401).json({ error: 'Invalid or expired 2FA challenge' })
      return
    }

    const { user, stellarPubKey, network, referralCode } = result

    if (referralCode) {
      try {
        await attributeSignup(user.id, referralCode)
      } catch (err) {
        logger.error(
          '[Auth] Referral attribution failed (2FA login unaffected):',
          err
        )
      }
    }

    const pair = await issueTokenPair(user.id)

    const userAgent = req.headers['user-agent'] ?? null
    const ipAddress = req.ip ?? null
    const deviceType = parseDeviceType(userAgent)
    const approxLocation = resolveApproxLocation(ipAddress)

    const session = await db.session.create({
      data: {
        userId: user.id,
        token: pair.accessToken,
        walletAddress: stellarPubKey,
        network,
        expiresAt: pair.expiresAt,
        ipAddress,
        userAgent,
        deviceType,
        approxLocation,
        lastSeenAt: new Date(),
        lastSeenIp: ipAddress,
        ...newRefreshTokenFields(pair),
      },
    })

    logger.info(`[Auth] Session created for user ${user.id} (post-2FA)`)

    const deepLinkToken = createSessionDeepLinkToken(user.id, session.id)
    publishUserEvent(user.id, 'alerts', 'security.new_session', {
      sessionId: session.id,
      deviceType,
      approxLocation,
      ipAddress: ipAddress ? `${ipAddress.slice(0, -3)}xxx` : null,
      createdAt: session.createdAt.toISOString(),
      revokeLink: `/sessions?highlight=${session.id}&token=${deepLinkToken}`,
    }).catch((err) =>
      logger.warn('[Auth] Failed to emit security.new_session', { err })
    )

    res.status(200).json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      userId: user.id,
      expiresAt: pair.expiresAt.toISOString(),
      refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
    })
  } catch (error) {
    logger.error('[Auth] TOTP verify error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * POST /api/auth/refresh
 *
 * Body: { refreshToken: string }
 *
 * #472 – Rotation with replay detection. The whole state machine lives in
 * services/refresh-token.service.ts; this handler only maps the outcome to a
 * status code. Presenting a token that was already exchanged revokes the whole
 * session, and the caller still sees a generic 401 so the endpoint cannot be
 * used as an "is this token real?" oracle.
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken?: unknown }

  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    res.status(400).json({ error: 'refreshToken is required' })
    return
  }

  try {
    const result = await rotateRefreshToken(refreshToken)

    if (!result.ok) {
      const mapped = REFRESH_ERRORS[result.reason]
      res.status(mapped.status).json({ error: mapped.error })
      return
    }

    res.status(200).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      refreshExpiresAt: result.refreshExpiresAt,
    })
  } catch (error) {
    logger.error('[Auth] Refresh error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * POST /api/auth/logout
 *
 * #472 – Soft revoke instead of DELETE. The previous implementation ran
 * `deleteMany({ token })`, which removed the row outright: the user lost the
 * entry in their session list and no record survived that the session had been
 * terminated. The row is kept for REVOKED_SESSION_RETAIN_DAYS, and the refresh
 * material is cleared so a refresh token captured before the logout cannot
 * resurrect the session.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const authorization = req.header('Authorization') ?? ''
  const token = authorization.split(' ')[1] ?? ''

  try {
    const session = token
      ? await db.session.findFirst({ where: { token } })
      : null

    if (!session) {
      // Nothing to revoke. Stay 200 so logout is idempotent: a client retrying
      // after a network timeout should not surface an error.
      res.status(200).json({ message: 'Logged out successfully' })
      return
    }

    // #316: a revoked session must kill the user's live sockets, not just block
    // the next handshake. revokeSession() closes them on this pod; sockets on
    // other pods fall to the WS_SESSION_RECHECK_MS recheck.
    await revokeSession(session.id, 'logout', {
      userId: session.userId,
      deviceType: session.deviceType,
      approxLocation: session.approxLocation,
    })

    logger.info('[Auth] Session revoked for user', {
      userId: req.userId ?? session.userId,
      sessionId: session.id,
    })

    res.status(200).json({ message: 'Logged out successfully' })
  } catch (error) {
    logger.error('[Auth] Logout error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
