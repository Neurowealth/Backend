/**
 * TOTP (Time-based One-Time Password) service for 2FA (#abf9a99).
 *
 * Manages enrollment, verification, and challenge flows for TOTP second-factor
 * authentication. Credentials are stored in the `TotpCredential` model.
 */

import { Network } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { randomBytes, createHmac, timingSafeEqual } from 'crypto'

// ── Types ─────────────────────────────────────────────────────────────────

export interface TotpChallenge {
  challengeToken: string
  expiresAt: Date
  userId: string
  stellarPubKey: string
  referralCode?: string | null
}

export interface TotpChallengeResult {
  ok: true
  user: {
    id: string
    walletAddress: string
    displayName: string | null
    email: string | null
    network: Network
  }
  stellarPubKey: string
  network: Network
  referralCode?: string | null
}

export interface TotpChallengeFailure {
  ok: false
  reason: 'expired' | 'invalid_code' | 'not_found' | 'locked'
}

// In-memory challenge store (sufficient for single-instance deployments;
// Redis-backed variant would be needed for multi-instance).
const pendingChallenges = new Map<string, TotpChallenge>()
const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── Per-account brute-force protection ────────────────────────────────────────

const MAX_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15 minutes

interface TotpAttemptRecord {
  count: number
  lockedUntil: Date | null
  /** Time step used on last successful verification — prevents replay within the same window. */
  lastUsedStep: number | null
}

const totpAttempts = new Map<string, TotpAttemptRecord>()

function getAttemptRecord(userId: string): TotpAttemptRecord {
  return totpAttempts.get(userId) ?? { count: 0, lockedUntil: null, lastUsedStep: null }
}

function recordFailedAttempt(userId: string): void {
  const record = getAttemptRecord(userId)
  const count = record.count + 1
  const lockedUntil = count >= MAX_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_DURATION_MS)
    : record.lockedUntil
  totpAttempts.set(userId, { ...record, count, lockedUntil })
  logger.warn('[TOTP] Failed verification attempt', { userId, count, locked: count >= MAX_ATTEMPTS })
}

function clearAttemptRecord(userId: string, usedStep: number): void {
  totpAttempts.set(userId, { count: 0, lockedUntil: null, lastUsedStep: usedStep })
}

/** Admin-facing: clear lockout for a user so they can retry TOTP. */
export function unlockTotpCredential(userId: string): void {
  const record = getAttemptRecord(userId)
  totpAttempts.set(userId, { ...record, count: 0, lockedUntil: null })
  logger.info('[TOTP] Lockout cleared by admin', { userId })
}

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
 * Uses constant-time comparison to prevent timing oracle attacks.
 * Returns the matched time step so callers can prevent replay, or null on failure.
 */
export function verifyTotpCode(secret: string, code: string): number | null {
  const step = currentTimeStep()
  for (const delta of [-1, 0, 1]) {
    const expected = computeTotp(secret, step + delta)
    const a = Buffer.from(expected.padStart(6, '0'))
    const b = Buffer.from(code.padStart(6, '0'))
    if (a.length === b.length && timingSafeEqual(a, b)) return step + delta
  }
  return null
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Return the active (verified) TOTP credential for a user, or null if the user
 * has no verified 2FA credential.
 */
export async function getActiveTotpCredential(userId: string) {
  return db.totpCredential.findFirst({
    where: { userId, verifiedAt: { not: null } },
    select: { id: true, userId: true, verifiedAt: true, secretEncrypted: true },
  })
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function toBase32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * Start (or restart) TOTP enrollment. Issues a fresh unverified secret; the
 * credential only becomes active after `verifyTotpEnrollment` succeeds.
 */
export async function beginTotpEnrollment(
  userId: string,
  accountLabel: string
): Promise<{ secret: string; otpauthUri: string }> {
  const existing = await db.totpCredential.findUnique({ where: { userId } })
  if (existing?.verifiedAt) {
    throw new Error('2FA is already enabled')
  }

  const raw = randomBytes(20)
  const secretEncrypted = raw.toString('base64')
  await db.totpCredential.upsert({
    where: { userId },
    create: { userId, secretEncrypted, iv: '', authTag: '' },
    update: { secretEncrypted, verifiedAt: null },
  })

  const secret = toBase32(raw)
  const label = encodeURIComponent(`NeuroWealth:${accountLabel}`)
  const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=NeuroWealth&algorithm=SHA1&digits=6&period=30`
  return { secret, otpauthUri }
}

/** Confirm enrollment with a code from the authenticator app. */
export async function verifyTotpEnrollment(
  userId: string,
  code: string
): Promise<boolean> {
  const credential = await db.totpCredential.findUnique({ where: { userId } })
  if (!credential || credential.verifiedAt) return false

  const step = verifyTotpCode(credential.secretEncrypted, code)
  if (step === null) return false

  await db.totpCredential.update({
    where: { userId },
    data: { verifiedAt: new Date(), lastAcceptedStep: BigInt(step) },
  })
  logger.info('[TOTP] Enrollment verified', { userId })
  return true
}

/**
 * Issue a TOTP step-up challenge token that the caller must resolve via
 * `completeTotpChallenge`. The token is opaque and short-lived.
 *
 * @returns challenge token string
 */
export async function issueTotpChallenge(
  userId: string,
  meta: {
    stellarPubKey: string
    referralCode?: string | null
    userAgent?: string | null
    ipAddress?: string | null
  }
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)

  pendingChallenges.set(token, {
    challengeToken: token,
    expiresAt,
    userId,
    stellarPubKey: meta.stellarPubKey,
    referralCode: meta.referralCode ?? null,
  })

  // Evict expired challenges opportunistically on issue.
  for (const [k, v] of pendingChallenges) {
    if (v.expiresAt < new Date()) pendingChallenges.delete(k)
  }

  logger.debug('[TOTP] Challenge issued', { userId })
  return { token, expiresAt }
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

  const { userId } = challenge

  // Check per-account lockout before touching the credential
  const attemptRecord = getAttemptRecord(userId)
  if (attemptRecord.lockedUntil && attemptRecord.lockedUntil > new Date()) {
    logger.warn('[TOTP] Account locked out', { userId, lockedUntil: attemptRecord.lockedUntil })
    return { ok: false, reason: 'locked' }
  }

  const credential = await db.totpCredential.findUnique({
    where: { userId },
    select: { secretEncrypted: true, verifiedAt: true },
  })

  if (!credential?.verifiedAt) {
    recordFailedAttempt(userId)
    return { ok: false, reason: 'invalid_code' }
  }

  const matchedStep = verifyTotpCode(credential.secretEncrypted, code)

  if (matchedStep === null) {
    recordFailedAttempt(userId)
    return { ok: false, reason: 'invalid_code' }
  }

  // Prevent replay: reject if this time step was already consumed
  if (attemptRecord.lastUsedStep === matchedStep) {
    recordFailedAttempt(userId)
    logger.warn('[TOTP] Time-step replay rejected', { userId, matchedStep })
    return { ok: false, reason: 'invalid_code' }
  }

  clearAttemptRecord(userId, matchedStep)
  pendingChallenges.delete(challengeToken)

  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      walletAddress: true,
      displayName: true,
      email: true,
      network: true,
    },
  })

  logger.info('[TOTP] Challenge completed', { userId })

  return {
    ok: true,
    user,
    stellarPubKey: challenge.stellarPubKey,
    network: user.network,
    referralCode: challenge.referralCode,
  }
}

/**
 * Convenience namespace export for consumers that import the service as a
 * single object (`import { totpService } from './totp.service'`).
 */
export const totpService = {
  getActiveTotpCredential,
  issueTotpChallenge,
  completeTotpChallenge,
  verifyTotpCode,
  unlockTotpCredential,
}
