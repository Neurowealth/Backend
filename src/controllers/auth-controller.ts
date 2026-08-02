// src/controllers/auth-controller.ts
// #214 – adds refresh token rotation; updates verify() and logout()
import { Request, Response } from 'express'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { Keypair } from '@stellar/stellar-sdk'
import { JwtAdapter, config } from '../config'
import { logger } from '../utils/logger'
import db from '../db'
import { stellarVerification } from '../utils/stellar/stellar-verification'
import { attributeSignup } from '../referral/service'

// ── Helpers ────────────────────────────────────────────────────────────────

async function hashToken(raw: string): Promise<string> {
  return bcrypt.hash(raw, 10)
}

async function compareToken(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash)
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

    // #214 – issue short-lived access token + long-lived refresh token
    const accessToken = await JwtAdapter.generateAccessToken({ id: user.id })
    const refreshToken = JwtAdapter.generateRefreshToken() // opaque, 48 bytes
    const accessExpires = JwtAdapter.accessTokenExpiresAt()
    const refreshExpires = JwtAdapter.refreshTokenExpiresAt()

    if (!accessToken) {
      res.status(500).json({ error: 'Failed to generate token' })
      return
    }

    const refreshHash = await hashToken(refreshToken)

    await db.session.create({
      data: {
        userId: user.id,
        token: accessToken, // access token stored for session lookup
        walletAddress: stellarPubKey,
        network,
        expiresAt: accessExpires, // access token expiry
        refreshTokenHash: refreshHash, // hashed refresh token
        refreshTokenExpiresAt: refreshExpires,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    })

    logger.info(`[Auth] Session created for user ${user.id}`)

    res.status(200).json({
      accessToken,
      refreshToken, // returned ONCE — not stored in plaintext
      userId: user.id,
      expiresAt: accessExpires.toISOString(),
      refreshExpiresAt: refreshExpires.toISOString(),
    })
  } catch (error) {
    logger.error('[Auth] Verify error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * POST /api/auth/refresh
 *
 * Body: { refreshToken: string }
 *
 * #214 – Refresh token rotation:
 *   1. Accept the raw refresh token from the client.
 *   2. Find the session whose refreshTokenHash matches (bcrypt compare).
 *   3. Reject if expired or already used (hash consumed on each rotation).
 *   4. Issue a new access token + new refresh token.
 *   5. Update the session row: new access token, new refresh hash, new expiries.
 *
 * Old refresh token is invalidated immediately upon use (single-use).
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken?: string }

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'refreshToken is required' })
    return
  }

  try {
    const now = new Date()

    // Narrow candidate set: non-expired refresh tokens only
    const candidates = await (db as any).session.findMany({
      where: {
        refreshTokenHash: { not: null },
        refreshTokenExpiresAt: { gt: now },
      },
      include: { user: { select: { id: true, isActive: true } } },
    })

    let matched: (typeof candidates)[number] | null = null

    for (const candidate of candidates) {
      if (!candidate.refreshTokenHash) continue
      const ok = await compareToken(refreshToken, candidate.refreshTokenHash)
      if (ok) {
        matched = candidate
        break
      }
    }

    if (!matched) {
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    if (!matched.user.isActive) {
      res.status(401).json({ error: 'User account is inactive' })
      return
    }

    // Issue new token pair
    const newAccessToken = await JwtAdapter.generateAccessToken({
      id: matched.userId,
    })
    const newRefreshToken = JwtAdapter.generateRefreshToken()
    const newAccessExpires = JwtAdapter.accessTokenExpiresAt()
    const newRefreshExpires = JwtAdapter.refreshTokenExpiresAt()

    if (!newAccessToken) {
      res.status(500).json({ error: 'Failed to generate access token' })
      return
    }

    const newRefreshHash = await hashToken(newRefreshToken)

    // Rotate: update the session with new tokens (old refresh token is now invalid)
    await (db as any).session.update({
      where: { id: matched.id },
      data: {
        token: newAccessToken,
        expiresAt: newAccessExpires,
        refreshTokenHash: newRefreshHash,
        refreshTokenExpiresAt: newRefreshExpires,
      },
    })

    logger.info(`[Auth] Refresh token rotated for user ${matched.userId}`)

    res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newAccessExpires.toISOString(),
      refreshExpiresAt: newRefreshExpires.toISOString(),
    })
  } catch (error) {
    logger.error('[Auth] Refresh error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * POST /api/auth/logout
 *
 * #214 – Revokes BOTH the access token and the refresh token by deleting all
 * sessions for the current user (covers multi-device if desired) or just the
 * matched access-token session.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const authorization = req.header('Authorization') ?? ''
  const token = authorization.split(' ')[1] ?? ''

  try {
    // Delete the session matched by access token (also nukes its refresh token hash)
    await db.session.deleteMany({ where: { token } })
    logger.info(`[Auth] Session revoked for user ${req.userId}`)
    res.status(200).json({ message: 'Logged out successfully' })
  } catch (error) {
    logger.error('[Auth] Logout error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
