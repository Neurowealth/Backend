/**
 * TOTP (Time-based One-Time Password) service for 2FA (#abf9a99).
 *
 * Manages enrollment, verification, and challenge flows for TOTP second-factor
 * authentication. Credentials are stored in the `TotpCredential` model.
 */

import db from '../db'
import { logger } from '../utils/logger'
import { randomBytes } from 'crypto'
import { createHmac } from 'crypto'

// ── Types ─────────────────────────────────────────────────────────────────

export interface TotpChallenge {
  challengeToken: string
  expiresAt: Date
  userId: string
  stellarPubKey: string
  network: string
  referralCode?: string | null
}

export interface TotpChallengeResult {
  ok: true
  user: { id: string; walletAddress: string; displayName: string | null; email: string | null; network: string }
  stellarPubKey: string
  network: string
  referralCode?: string | null
}

export interface TotpChallengeFailure {
  ok: false
  reason: 'expired' | 'invalid_code' | 'not_found'
}

// In-memory challenge store (sufficient for single-instance deployments;
// Redis-backed variant would be needed for multi-instance).
const pendingChallenges = new Map<string, TotpChallenge>()
const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Derive a TOTP code from a shared secret and a time step.
 * Uses HMAC-SHA1 per RFC 6238.
 */
function computeTotp(secret: string, timeStep: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigInt64BE(BigInt(timeStep))

  const secretBuf = Buffer.from(secret, 'base64')
  const hmac = createHmac('sha1', secretBuf).update(buf).digest()

  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  return String(code % 1_000_000).padStart(6, '0')
}

function currentTimeStep(): number {
  return Math.floor(Date.now() / 1000 / 30)
}

/**
 * Verify a TOTP code against a secret, allowing ±1 time-step drift.
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  const step = currentTimeStep()
  for (const delta of [-1, 0, 1]) {
    if (computeTotp(secret, step + delta) === code) return true
  }
  return false
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Return the active (verified) TOTP credential for a user, or null if the user
 * has no verified 2FA credential.
 */
export async function getActiveTotpCredential(userId: string) {
  return db.totpCredential.findUnique({
    where: { userId },
    select: { id: true, userId: true, verifiedAt: true, secret: true },
  })
}

/**
 * Issue a TOTP step-up challenge token that the caller must resolve via
 * `completeTotpChallenge`. The token is opaque and short-lived.
 *
 * @returns challenge token string
 */
export async function issueTotpChallenge(params: {
  userId: string
  stellarPubKey: string
  network: string
  referralCode?: string | null
}): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)

  pendingChallenges.set(token, {
    challengeToken: token,
    expiresAt,
    userId: params.userId,
    stellarPubKey: params.stellarPubKey,
    network: params.network,
    referralCode: params.referralCode ?? null,
  })

  // Evict expired challenges opportunistically on issue.
  for (const [k, v] of pendingChallenges) {
    if (v.expiresAt < new Date()) pendingChallenges.delete(k)
  }

  logger.debug('[TOTP] Challenge issued', { userId: params.userId })
  return token
}

/**
 * Complete a TOTP challenge by verifying the code against the stored challenge
 * and the user's active credential.
 */
export async function completeTotpChallenge(
  challengeToken: string,
  code: string
): Promise<TotpChallengeResult | TotpChallengeFailure> {
  const challenge = pendingChallenges.get(challengeToken)
  if (!challenge) {
    return { ok: false, reason: 'not_found' }
  }

  if (challenge.expiresAt < new Date()) {
    pendingChallenges.delete(challengeToken)
    return { ok: false, reason: 'expired' }
  }

  const credential = await db.totpCredential.findUnique({
    where: { userId: challenge.userId },
    select: { secret: true, verifiedAt: true },
  })

  if (!credential?.verifiedAt || !verifyTotpCode(credential.secret, code)) {
    return { ok: false, reason: 'invalid_code' }
  }

  pendingChallenges.delete(challengeToken)

  const user = await db.user.findUniqueOrThrow({
    where: { id: challenge.userId },
    select: { id: true, walletAddress: true, displayName: true, email: true, network: true },
  })

  logger.info('[TOTP] Challenge completed', { userId: challenge.userId })

  return {
    ok: true,
    user,
    stellarPubKey: challenge.stellarPubKey,
    network: challenge.network,
    referralCode: challenge.referralCode,
  }
}
