/**
 * Guardian-based social recovery (#535).
 *
 * Recovery of a user's own ACCOUNT ACCESS — their sessions and ability to
 * authenticate — not of the custodial wallet's key material, which the platform
 * already holds and which is a different problem (src/keys/registry.ts). See
 * docs/ACCOUNT_RECOVERY.md for the full threat model and its stated limits.
 *
 * ── Why this design is the way it is ────────────────────────────────────────
 *
 * The feature optimises for one property: making UNAUTHORIZED recovery hard.
 * Legitimate recovery is allowed to be slow and annoying. Three structural
 * defences do the work, and each is enforced in more than one place on purpose:
 *
 *   1. QUORUM, NEVER 1-OF-N. Two independent guardians must agree. Enforced
 *      three times: `assertPolicyIsSane()` on every read, a database CHECK
 *      constraint, and the Zod schema on the update path. A quorum of one would
 *      make every other control here decorative.
 *
 *   2. A MANDATORY, NON-NEGOTIABLE DELAY between quorum and effect. Stamped
 *      ONCE, at quorum, onto the request row itself (`executeAfter`) rather
 *      than read from the policy at execution time — so editing or deleting the
 *      policy mid-flight cannot pull a live deadline forward. This window is the
 *      single most important thing in the feature: it is the time in which the
 *      real owner, who may have lost only their phone, gets a chance to notice
 *      and stop it.
 *
 *   3. LOUD, MULTI-CHANNEL ALERTING on initiation, to the account's own
 *      registered contact info as well as to every guardian. Guardians can
 *      all be socially engineered; the owner's address is the one channel the
 *      claimant does not control. See ./notifications.ts.
 *
 * Cancellation is deliberately EASIER than approval: the owner can stop a
 * pending request unilaterally, at any point, with no guardian consensus. That
 * asymmetry is intentional and must not be "improved" away.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 *
 * It does not verify that the claimant is the owner. It cannot — a locked-out
 * user and an attacker are indistinguishable at the start. Guardians are the
 * verification mechanism in v1. Automated identity re-verification is out of
 * scope for v1, and the delay plus alerting are what stand in its place.
 */

import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { appendAuditBlock } from '../audit/chain'
import { revokeSession } from '../services/refresh-token.service'
import {
  notifyGuardiansOfRequest,
  notifyGuardianInvitation,
  notifyQuorumReached,
  notifyRecoveryCancelled,
  notifyRecoveryCompleted,
  notifyRecoveryInitiated,
} from './notifications'

type Db = typeof db | Prisma.TransactionClient

// ─── Constants ──────────────────────────────────────────────────────────────

/** A quorum below this is never acceptable, whatever a caller asks for. */
export const MIN_REQUIRED_APPROVALS = 2
export const MIN_RECOVERY_DELAY_HOURS = 24
export const MAX_RECOVERY_DELAY_HOURS = 168
export const MAX_GUARDIAN_CAP = 20

export const DEFAULT_REQUIRED_APPROVALS = 2
export const DEFAULT_RECOVERY_DELAY_HOURS = 48
export const DEFAULT_MAX_GUARDIANS = 5

/** How long a guardian has to respond to a nomination. */
export const GUARDIAN_INVITE_TTL_HOURS = 168

/**
 * Hard lifetime of a recovery request, set at initiation whether or not quorum
 * is ever reached. Without it an abandoned request stays PENDING forever and a
 * later approval on an ancient request looks like a fresh one.
 */
export const REQUEST_EXPIRY_DAYS = 30

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * A typed failure. Routes map `code` to an HTTP status instead of
 * string-matching on messages, which is how the first draft of this feature
 * turned a typo in a log line into a 500.
 */
export type RecoveryErrorCode =
  | 'self_nomination'
  | 'no_guardian_identifier'
  | 'guardian_not_found'
  | 'guardian_already_exists'
  | 'guardian_limit_reached'
  | 'guardian_not_accepted'
  | 'invalid_invite_token'
  | 'invite_expired'
  | 'invite_already_responded'
  | 'not_primary_account'
  | 'insufficient_guardians'
  | 'insufficient_policy'
  | 'request_not_found'
  | 'request_closed'
  | 'not_request_owner'
  | 'delay_not_elapsed'
  | 'already_decided'
  | 'invalid_policy'

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode
  readonly status: number

  constructor(code: RecoveryErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'RecoveryError'
    this.code = code
    this.status = status
    Object.setPrototypeOf(this, RecoveryError.prototype)
  }
}

const HTTP_STATUS: Record<RecoveryErrorCode, number> = {
  self_nomination: 400,
  no_guardian_identifier: 400,
  guardian_not_found: 404,
  guardian_already_exists: 409,
  guardian_limit_reached: 409,
  guardian_not_accepted: 409,
  invalid_invite_token: 404,
  invite_expired: 410,
  invite_already_responded: 409,
  not_primary_account: 403,
  insufficient_guardians: 409,
  insufficient_policy: 409,
  request_not_found: 404,
  request_closed: 409,
  not_request_owner: 403,
  delay_not_elapsed: 409,
  already_decided: 409,
  invalid_policy: 400,
}

export function recoveryErrorStatus(code: RecoveryErrorCode): number {
  return HTTP_STATUS[code] ?? 400
}

/** Normalise anything thrown here into a RecoveryError. */
export function toRecoveryError(err: unknown): RecoveryError {
  if (err instanceof RecoveryError) return err
  return new RecoveryError(
    'request_not_found',
    err instanceof Error ? err.message : 'Unknown recovery error',
    500
  )
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type GuardianStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REMOVED'
export type RequestStatus =
  | 'PENDING'
  | 'QUORUM_REACHED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'EXPIRED'

/** Statuses in which a request is still alive and can still be acted on. */
export const OPEN_REQUEST_STATUSES: RequestStatus[] = [
  'PENDING',
  'QUORUM_REACHED',
]

export interface RecoveryPolicyView {
  requiredApprovals: number
  recoveryDelayHours: number
  maxGuardians: number
}

export interface GuardianView {
  id: string
  status: GuardianStatus
  /** 'platform' | 'email' | 'phone' — how this guardian is reached. */
  kind: 'platform' | 'email' | 'phone'
  /**
   * Masked for anything not already authenticated as this guardian. The
   * nominator only ever needs to recognise their own contact list, and a
   * recovery feature is an excellent way to enumerate a target's associates.
   */
  label: string
  acceptedAt: string | null
  createdAt: string
}

export interface RecoveryRequestView {
  id: string
  userId: string
  status: RequestStatus
  reason: string
  requiredApprovals: number | null
  recoveryDelayHours: number | null
  quorumReachedAt: string | null
  executeAfter: string | null
  executedAt: string | null
  cancelledAt: string | null
  expiresAt: string | null
  createdAt: string
  approvals: Array<{
    guardianId: string
    approved: boolean
    decidedAt: string
    /** 'session' | 'external_token' — proof the guardian was identified. */
    method: string
  }>
  /** Whether the delay window has elapsed and execution is now permitted. */
  readyToExecute: boolean
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/**
 * SHA-256 of the raw invite/approval token. The raw token exists exactly once,
 * in the response that created it and in the out-of-band message that carried
 * it; the database only ever holds this digest. Same precedent as
 * EmailIdentity.verifyTokenHash.
 */
export function hashRecoveryToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

/** 32 bytes of CSPRNG entropy, hex-encoded. */
function generateRecoveryToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Strip control characters and clamp length from anything a claimant typed.
 *
 * `reason` is attacker-controlled free text that ends up in an audit payload
 * and (via the mail templates) in an email body. Templates interpolate it into
 * the PLAINTEXT part only, never the HTML part, but stripping control
 * characters here means it cannot forge a header or a fake log line either.
 */
export function sanitizeReason(input: string, maxLength = 500): string {
  // eslint-disable-next-line no-control-regex
  return input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/**
 * `alice@example.com` -> `a***e@example.com`, `+14155550123` -> `+1*****0123`.
 * Enough for an owner to recognise their own list, not enough to harvest it.
 */
export function maskContact(value: string): string {
  if (value.includes('@')) {
    const [local, domain] = value.split('@')
    if (!local || !domain) return '***'
    if (local.length <= 2) return `${local[0]}***@${domain}`
    return `${local[0]}***${local[local.length - 1]}@${domain}`
  }
  const digits = value.replace(/[^\d]/g, '')
  if (digits.length <= 4) return '*'.repeat(digits.length)
  return `${value.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`
}

/**
 * Every recovery event is written to the hash-chained audit feed (#315).
 *
 * Uses the same `appendAuditBlock` call shape as the rest of the codebase
 * (src/protectionFund/service.ts and friends): the block is computed here and
 * chained by the persistence job. Recovery events are `ADMIN_BATCH` because
 * they are privileged, operator-visible state changes rather than user
 * transactions, and because an operator investigating a takeover must be able
 * to find them by block type.
 */
function audit(event: Record<string, unknown>): void {
  try {
    appendAuditBlock({
      height: 0,
      prevHash: 'sha256:0',
      payloadHash: 'sha256:0',
      blockType: 'ADMIN_BATCH',
      createdAt: new Date(),
      payloads: [event],
    })
  } catch (err) {
    // An audit write must never take down the operation it describes, but it
    // must be loud — a recovery event that silently failed to be recorded is
    // exactly the thing an incident review would need.
    logger.error('[Guardians] Failed to append audit block', {
      event,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function nowPlusHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

// ─── Account shape ──────────────────────────────────────────────────────────

/**
 * Social recovery applies to a PRIMARY account owner only (v1).
 *
 * A sub-account's access is delegated by a parent account that already exists
 * and already holds a recovery path of its own, so a second, independent
 * mechanism for it would be redundant and would multiply the ways a child
 * account could be taken over. Recovery for a sub-account is routed through the
 * parent; this guard makes sure a request aimed at one is refused rather than
 * quietly opening a request nobody is watching.
 */
export async function assertPrimaryAccountOwner(
  userId: string,
  database: Db = db
): Promise<void> {
  const parentLink = await database.subAccount.findFirst({
    where: { childUserId: userId, status: 'ACTIVE' },
    select: { id: true },
  })

  if (parentLink) {
    throw new RecoveryError(
      'not_primary_account',
      'Social recovery applies to primary accounts only. A sub-account recovers through its parent account.',
      403
    )
  }
}

// ─── Recovery policy ────────────────────────────────────────────────────────

/**
 * Reject a policy that would make the structural defences meaningless. Called
 * on every policy READ, not just on write, so a row that somehow bypassed the
 * write path and the database CHECK (a hand-edited row, a restored dump) still
 * cannot be used to authorise a recovery.
 */
function assertPolicyIsSane(policy: {
  requiredApprovals: number
  recoveryDelayHours: number
}): void {
  if (policy.requiredApprovals < MIN_REQUIRED_APPROVALS) {
    throw new RecoveryError(
      'insufficient_policy',
      `Refusing to act on a recovery policy requiring only ${policy.requiredApprovals} approval(s); a quorum below ${MIN_REQUIRED_APPROVALS} is never allowed.`,
      500
    )
  }
  if (policy.recoveryDelayHours < MIN_RECOVERY_DELAY_HOURS) {
    throw new RecoveryError(
      'insufficient_policy',
      `Refusing to act on a recovery policy with a ${policy.recoveryDelayHours}h delay; the mandatory waiting period cannot be shorter than ${MIN_RECOVERY_DELAY_HOURS}h.`,
      500
    )
  }
}

export async function getOrCreateRecoveryPolicy(
  userId: string,
  database: Db = db
): Promise<RecoveryPolicyView> {
  let policy = await database.recoveryPolicy.findUnique({ where: { userId } })

  if (!policy) {
    policy = await database.recoveryPolicy.create({
      data: { userId },
    })
  }

  assertPolicyIsSane(policy)
  return {
    requiredApprovals: policy.requiredApprovals,
    recoveryDelayHours: policy.recoveryDelayHours,
    maxGuardians: policy.maxGuardians,
  }
}

export async function updateRecoveryPolicy(
  userId: string,
  input: { requiredApprovals?: number; recoveryDelayHours?: number },
  database: Db = db
): Promise<RecoveryPolicyView> {
  const current = await getOrCreateRecoveryPolicy(userId, database)

  const requiredApprovals = input.requiredApprovals ?? current.requiredApprovals
  const recoveryDelayHours =
    input.recoveryDelayHours ?? current.recoveryDelayHours

  if (requiredApprovals < MIN_REQUIRED_APPROVALS) {
    throw new RecoveryError(
      'invalid_policy',
      `requiredApprovals must be at least ${MIN_REQUIRED_APPROVALS}. A 1-of-N quorum would let a single compromised guardian take over the account.`
    )
  }
  if (recoveryDelayHours < MIN_RECOVERY_DELAY_HOURS) {
    throw new RecoveryError(
      'invalid_policy',
      `recoveryDelayHours must be at least ${MIN_RECOVERY_DELAY_HOURS}. The waiting period is the structural defence against a colluding minority and is not configurable below one day.`
    )
  }
  if (recoveryDelayHours > MAX_RECOVERY_DELAY_HOURS) {
    throw new RecoveryError(
      'invalid_policy',
      `recoveryDelayHours must be ${MAX_RECOVERY_DELAY_HOURS} or fewer.`
    )
  }

  // A quorum larger than the number of accepted guardians would be
  // unsatisfiable, i.e. the account could never be recovered at all. That is
  // arguably a valid choice, but it is almost always a misconfiguration, so it
  // is refused at the point of the mistake.
  const acceptedCount = await database.recoveryGuardian.count({
    where: { userId, status: 'ACCEPTED' },
  })
  if (requiredApprovals > acceptedCount) {
    throw new RecoveryError(
      'invalid_policy',
      `requiredApprovals (${requiredApprovals}) exceeds the number of accepted guardians (${acceptedCount}). The recovery could never reach quorum.`,
      409
    )
  }

  const updated = await database.recoveryPolicy.update({
    where: { userId },
    data: { requiredApprovals, recoveryDelayHours },
  })

  audit({
    type: 'RECOVERY_POLICY_UPDATED',
    userId,
    requiredApprovals: updated.requiredApprovals,
    recoveryDelayHours: updated.recoveryDelayHours,
  })

  return {
    requiredApprovals: updated.requiredApprovals,
    recoveryDelayHours: updated.recoveryDelayHours,
    maxGuardians: updated.maxGuardians,
  }
}

// ─── Guardian nomination ────────────────────────────────────────────────────

export interface NominateGuardianResult {
  guardian: GuardianView
  /**
   * The raw acceptance token. Returned EXACTLY ONCE and never stored in clear;
   * deliver it to the guardian out of band and drop it.
   */
  inviteToken: string
  inviteExpiresAt: string
}

export async function nominateGuardian(
  input: {
    userId: string
    guardianUserId?: string
    externalEmail?: string
    externalPhone?: string
  },
  database: Db = db
): Promise<NominateGuardianResult> {
  const { userId, guardianUserId, externalEmail, externalPhone } = input

  if (!guardianUserId && !externalEmail && !externalPhone) {
    throw new RecoveryError(
      'no_guardian_identifier',
      'Provide guardianUserId, externalEmail, or externalPhone to identify the guardian.'
    )
  }

  if (guardianUserId && guardianUserId === userId) {
    throw new RecoveryError(
      'self_nomination',
      'You cannot nominate yourself as your own guardian. Recovery requires a party other than the account owner.'
    )
  }

  // Re-nominating an existing guardian is treated as a fresh invitation rather
  // than an error, so an owner who mistyped an address or whose guardian
  // declined can try again. Silent enrolment is still impossible: the row
  // returns to PENDING and the new token must be accepted before the guardian
  // counts toward quorum.
  const identityFilters = [
    ...(guardianUserId ? [{ guardianUserId }] : []),
    ...(externalEmail ? [{ externalEmail }] : []),
    ...(externalPhone ? [{ externalPhone }] : []),
  ]

  const existing = await database.recoveryGuardian.findFirst({
    where: {
      userId,
      status: { in: ['PENDING', 'ACCEPTED'] },
      OR: identityFilters,
    },
    select: { id: true },
  })

  if (existing) {
    const activeCount = await database.recoveryGuardian.count({
      where: { userId, status: { in: ['PENDING', 'ACCEPTED'] } },
    })
    const policy = await getOrCreateRecoveryPolicy(userId, database)
    if (activeCount >= policy.maxGuardians) {
      throw new RecoveryError(
        'guardian_limit_reached',
        `This account already has ${activeCount} guardian(s), which is the configured maximum of ${policy.maxGuardians}. Remove one before adding another.`,
        409
      )
    }
  }

  if (guardianUserId) {
    const guardianUser = await database.user.findUnique({
      where: { id: guardianUserId },
      select: { id: true, isActive: true },
    })
    if (!guardianUser) {
      throw new RecoveryError(
        'guardian_not_found',
        'The nominated platform user does not exist.'
      )
    }
    if (!guardianUser.isActive) {
      throw new RecoveryError(
        'guardian_not_found',
        'The nominated platform user is not active.'
      )
    }
  }

  const policy = await getOrCreateRecoveryPolicy(userId, database)

  if (!existing) {
    const activeCount = await database.recoveryGuardian.count({
      where: { userId, status: { in: ['PENDING', 'ACCEPTED'] } },
    })
    if (activeCount >= policy.maxGuardians) {
      throw new RecoveryError(
        'guardian_limit_reached',
        `This account already has ${activeCount} guardian(s), which is the configured maximum of ${policy.maxGuardians}. Remove one before adding another.`,
        409
      )
    }
  }

  const rawToken = generateRecoveryToken()
  const inviteExpiresAt = nowPlusHours(GUARDIAN_INVITE_TTL_HOURS)

  const row = existing
    ? await database.recoveryGuardian.update({
        where: { id: existing.id },
        data: {
          guardianUserId: guardianUserId ?? null,
          externalEmail: externalEmail ?? null,
          externalPhone: externalPhone ?? null,
          status: 'PENDING',
          inviteTokenHash: hashRecoveryToken(rawToken),
          inviteExpiresAt,
          confirmedAt: null,
        },
      })
    : await database.recoveryGuardian.create({
        data: {
          userId,
          guardianUserId: guardianUserId ?? null,
          externalEmail: externalEmail ?? null,
          externalPhone: externalPhone ?? null,
          inviteTokenHash: hashRecoveryToken(rawToken),
          inviteExpiresAt,
        },
      })

  audit({
    type: 'GUARDIAN_NOMINATED',
    guardianId: row.id,
    userId,
    kind: guardianUserId ? 'platform' : externalEmail ? 'email' : 'phone',
  })

  // Deliver the invitation out of band. Deliberately fire-and-forget: the
  // nomination is already recorded, and a mail outage must not roll it back or
  // surface as a failed request. notifications.ts never throws.
  void notifyGuardianInvitation({
    guardianId: row.id,
    userId,
    accountHint: await maskedAccountHint(userId, database),
    inviteToken: rawToken,
    inviteExpiresAt: inviteExpiresAt.toISOString(),
    externalEmail: row.externalEmail,
    externalPhone: row.externalPhone,
  })

  return {
    guardian: toGuardianView(row),
    inviteToken: rawToken,
    inviteExpiresAt: inviteExpiresAt.toISOString(),
  }
}

/**
 * A short, non-reversible identifier for the account, safe to show to a
 * guardian who is being asked to vouch for it. A masked wallet address is
 * enough for them to recognise "this is the account I agreed to guard" without
 * handing them the full address.
 */
async function maskedAccountHint(
  userId: string,
  database: Db
): Promise<string> {
  try {
    const user = await database.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    })
    return user ? maskContact(user.walletAddress) : 'A NeuroWealth account'
  } catch {
    return 'A NeuroWealth account'
  }
}

function toGuardianView(row: {
  id: string
  status: string
  guardianUserId: string | null
  externalEmail: string | null
  externalPhone: string | null
  confirmedAt: Date | null
  createdAt: Date
}): GuardianView {
  const kind: GuardianView['kind'] = row.guardianUserId
    ? 'platform'
    : row.externalEmail
      ? 'email'
      : 'phone'

  const label = row.guardianUserId
    ? `Platform user ${row.guardianUserId.slice(0, 8)}`
    : row.externalEmail
      ? maskContact(row.externalEmail)
      : row.externalPhone
        ? maskContact(row.externalPhone)
        : 'unknown'

  return {
    id: row.id,
    status: row.status as GuardianStatus,
    kind,
    label,
    acceptedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listGuardians(
  userId: string,
  database: Db = db
): Promise<GuardianView[]> {
  const rows = await database.recoveryGuardian.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(toGuardianView)
}

/**
 * Resolve a raw token to its guardian row. Returns null rather than throwing so
 * both the accept path and the external-approval path can treat "unknown token"
 * the same way.
 */
async function findGuardianByToken(
  token: string,
  database: Db
): Promise<{
  id: string
  userId: string
  guardianUserId: string | null
  status: string
  inviteExpiresAt: Date
  inviteTokenHash: string
  externalEmail: string | null
  externalPhone: string | null
  confirmedAt: Date | null
  createdAt: Date
} | null> {
  return database.recoveryGuardian.findUnique({
    where: { inviteTokenHash: hashRecoveryToken(token) },
  })
}

function assertUsableToken(
  guardian: { status: string; inviteExpiresAt: Date },
  token: string
): void {
  // Constant-ish comparison is pointless here: the lookup above was already a
  // digest equality check, so possessing the token is proven. What matters is
  // that an expired or already-answered token cannot be reused.
  if (guardian.status !== 'PENDING' && guardian.status !== 'ACCEPTED') {
    throw new RecoveryError(
      'invite_already_responded',
      `This guardian nomination is no longer open (status: ${guardian.status}).`,
      409
    )
  }
  if (guardian.inviteExpiresAt.getTime() < Date.now()) {
    throw new RecoveryError(
      'invite_expired',
      'This guardian invitation has expired. The account owner can re-issue it.',
      410
    )
  }
  void token
}

/**
 * A platform guardian accepting through their authenticated session. Proves
 * the responder really is the nominated user, which is why it needs no token.
 */
export async function acceptGuardianInviteAsUser(
  input: { guardianId: string; actorUserId: string },
  database: Db = db
): Promise<GuardianView> {
  const guardian = await database.recoveryGuardian.findUnique({
    where: { id: input.guardianId },
  })

  if (!guardian || guardian.guardianUserId !== input.actorUserId) {
    throw new RecoveryError(
      'invalid_invite_token',
      'No pending guardian nomination for this user.',
      404
    )
  }
  assertUsableToken(guardian, '')

  const updated = await database.recoveryGuardian.update({
    where: { id: guardian.id },
    data: { status: 'ACCEPTED', confirmedAt: new Date() },
  })

  audit({
    type: 'GUARDIAN_ACCEPTED',
    guardianId: guardian.id,
    userId: guardian.userId,
    method: 'session',
  })

  return toGuardianView(updated)
}

/**
 * An EXTERNAL contact accepting via the token they were sent. This is the only
 * identity proof available to somebody with no platform account, which is why
 * the token is high-entropy, single-use for enrolment, and never sufficient on
 * its own to complete a recovery — approving still requires a separate, explicit
 * decision (see approveRecoveryAsExternalGuardian).
 */
export async function respondToGuardianInvite(
  input: { token: string; accept: boolean },
  database: Db = db
): Promise<GuardianView> {
  const guardian = await findGuardianByToken(input.token, database)

  if (!guardian) {
    throw new RecoveryError(
      'invalid_invite_token',
      'Invalid invitation token.',
      404
    )
  }
  assertUsableToken(guardian, input.token)

  if (guardian.status === 'ACCEPTED') {
    throw new RecoveryError(
      'invite_already_responded',
      'This nomination has already been accepted.',
      409
    )
  }

  const updated = await database.recoveryGuardian.update({
    where: { id: guardian.id },
    data: {
      status: input.accept ? 'ACCEPTED' : 'DECLINED',
      confirmedAt: input.accept ? new Date() : null,
    },
  })

  audit({
    type: input.accept ? 'GUARDIAN_ACCEPTED' : 'GUARDIAN_DECLINED',
    guardianId: guardian.id,
    userId: guardian.userId,
    method: 'external_token',
  })

  return toGuardianView(updated)
}

/**
 * Remove a guardian. Immediate and unconditional — an owner who suspects a
 * guardian has been compromised must be able to drop them without waiting for
 * that guardian's consent, exactly as with cancellation.
 */
export async function removeGuardian(
  input: { userId: string; guardianId: string },
  database: Db = db
): Promise<GuardianView> {
  const guardian = await database.recoveryGuardian.findFirst({
    where: { id: input.guardianId, userId: input.userId },
  })

  if (!guardian) {
    throw new RecoveryError('guardian_not_found', 'Guardian not found.', 404)
  }

  const updated = await database.recoveryGuardian.update({
    where: { id: guardian.id },
    data: { status: 'REMOVED' },
  })

  audit({
    type: 'GUARDIAN_REMOVED',
    guardianId: guardian.id,
    userId: input.userId,
  })

  return toGuardianView(updated)
}

// ─── Recovery request ───────────────────────────────────────────────────────

function toRequestView(
  row: {
    id: string
    userId: string
    status: string
    reason: string
    requiredApprovals: number | null
    recoveryDelayHours: number | null
    quorumReachedAt: Date | null
    executeAfter: Date | null
    executedAt: Date | null
    cancelledAt: Date | null
    expiresAt: Date | null
    createdAt: Date
  },
  approvals: Array<{
    guardianId: string
    approved: boolean
    decidedAt: Date
    method: string
  }> = []
): RecoveryRequestView {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status as RequestStatus,
    reason: row.reason,
    requiredApprovals: row.requiredApprovals,
    recoveryDelayHours: row.recoveryDelayHours,
    quorumReachedAt: row.quorumReachedAt?.toISOString() ?? null,
    executeAfter: row.executeAfter?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    approvals: approvals.map((a) => ({
      guardianId: a.guardianId,
      approved: a.approved,
      decidedAt: a.decidedAt.toISOString(),
      method: a.method,
    })),
    readyToExecute:
      row.status === 'QUORUM_REACHED' &&
      row.executeAfter !== null &&
      row.executeAfter.getTime() <= Date.now(),
  }
}

/**
 * Load a request plus its approvals, scoped so a caller who is neither the
 * owner nor a nominated guardian learns nothing.
 */
async function loadRequest(
  requestId: string,
  database: Db
): Promise<Awaited<ReturnType<typeof fetchRequestRow>> | null> {
  return fetchRequestRow(requestId, database)
}

async function fetchRequestRow(requestId: string, database: Db) {
  return database.recoveryRequest.findUnique({
    where: { id: requestId },
    include: {
      approvals: {
        select: {
          guardianId: true,
          approved: true,
          decidedAt: true,
          method: true,
        },
      },
    },
  })
}

export async function getRecoveryRequestForOwner(
  input: { requestId: string; userId: string },
  database: Db = db
): Promise<RecoveryRequestView> {
  const row = await loadRequest(input.requestId, database)
  if (!row) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }
  if (row.userId !== input.userId) {
    throw new RecoveryError(
      'not_request_owner',
      'This recovery request belongs to another account.',
      403
    )
  }
  return toRequestView(row, row.approvals)
}

/**
 * The claimant's door. Deliberately unauthenticated — the caller is by
 * definition someone who cannot sign in — and deliberately capable of nothing
 * except opening a request and ringing the alarm.
 *
 * Returns a shape the route must render IDENTICALLY whether or not the account
 * exists or has any guardians: a response that differs by target is a
 * enumeration oracle for "which wallets have a recovery setup", and wallets are
 * public on-chain. See `InitiationOutcome`.
 */
export interface InitiationOutcome {
  request: RecoveryRequestView | null
  acceptedGuardians: number
  requiredApprovals: number
}

export async function initiateRecovery(
  input: { walletAddress: string; reason: string },
  database: Db = db
): Promise<InitiationOutcome> {
  const reason = sanitizeReason(input.reason)

  const user = await database.user.findUnique({
    where: { walletAddress: input.walletAddress },
    select: { id: true },
  })

  // No such account: the route still answers 202 with the same body. There is
  // nothing to alert about and nothing to open.
  if (!user) {
    logger.info('[Guardians] Recovery initiated for an unknown wallet', {
      walletAddress: input.walletAddress,
    })
    return { request: null, acceptedGuardians: 0, requiredApprovals: 0 }
  }

  try {
    await assertPrimaryAccountOwner(user.id, database)
  } catch (err) {
    if (err instanceof RecoveryError && err.code === 'not_primary_account') {
      // Also answered with the same generic body: whether a wallet is a
      // sub-account is not the caller's business.
      logger.info('[Guardians] Recovery refused for a sub-account', {
        userId: user.id,
      })
      return { request: null, acceptedGuardians: 0, requiredApprovals: 0 }
    }
    throw err
  }

  const policy = await getOrCreateRecoveryPolicy(user.id, database)
  const acceptedGuardians = await database.recoveryGuardian.count({
    where: { userId: user.id, status: 'ACCEPTED' },
  })

  if (acceptedGuardians < policy.requiredApprovals) {
    // Cannot reach quorum, so there is nothing to alert anybody about and no
    // reason to open a request that can only sit there. Fails safe: this is the
    // "all guardians unreachable" case the design accepts (docs/ACCOUNT_RECOVERY.md).
    logger.info('[Guardians] Recovery refused: not enough accepted guardians', {
      userId: user.id,
      acceptedGuardians,
      requiredApprovals: policy.requiredApprovals,
    })
    return {
      request: null,
      acceptedGuardians,
      requiredApprovals: policy.requiredApprovals,
    }
  }

  const expiresAt = new Date(
    Date.now() + REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  )

  let request
  try {
    request = await database.recoveryRequest.create({
      data: { userId: user.id, reason, status: 'PENDING', expiresAt },
    })
  } catch (err) {
    // P2002 is recovery_requests_userId_live_key.
    //
    // This index is the ONLY thing enforcing one live request per account -- there
    // is no read-then-write check above, and that is deliberate. A pre-insert read
    // would still race: two concurrent initiations for the same wallet both read
    // "none" and both insert. On a public unauthenticated endpoint, reachability of
    // that race is not a matter of luck, so the guarantee belongs in the database
    // where it cannot be bypassed by a caller.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      logger.info('[Guardians] Recovery refused: a request is already open', {
        userId: user.id,
      })
      return {
        request: null,
        acceptedGuardians,
        requiredApprovals: policy.requiredApprovals,
      }
    }

    // Anything else is a real failure, not a duplicate. Surfacing it as
    // "already open" would be indistinguishable from success to the caller while
    // writing a false cause into the audit trail, and would hide an outage. Re-throw
    // so the route's generic error handler decides what the public endpoint
    // returns.
    logger.error('[Guardians] Recovery failed to create a request', {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  audit({
    type: 'RECOVERY_INITIATED',
    requestId: request.id,
    userId: user.id,
    requiredApprovals: policy.requiredApprovals,
    acceptedGuardians,
  })

  // ── Loud alerting ──────────────────────────────────────────────────────────
  // The owner is alerted FIRST and unconditionally. This is the load-bearing
  // safety property: even if every guardian has been compromised, the owner
  // learns and can cancel unilaterally. Guardians are alerted afterwards so a
  // slow guardian delivery can never delay the owner's notification.
  //
  // Tokens are re-minted per request rather than reusing the nomination token,
  // so the link a guardian gets here is only valid for this request and is not
  // the long-lived credential they accepted the role with.
  void notifyRecoveryInitiated({
    requestId: request.id,
    userId: user.id,
    reason,
    requiredApprovals: policy.requiredApprovals,
    acceptedGuardians,
  })

  void alertGuardiansAboutRequest(
    request.id,
    user.id,
    reason,
    policy.requiredApprovals,
    database
  )

  return {
    request: toRequestView(request, []),
    acceptedGuardians,
    requiredApprovals: policy.requiredApprovals,
  }
}

/**
 * Tell every accepted guardian that a decision is wanted, each with a link
 * bound to their own freshly minted token. Deliberately iterates guardians to
 * NOTIFY, never to decide: there is no path in this file that records an
 * approval without a single named guardian acting for themselves.
 */
async function alertGuardiansAboutRequest(
  requestId: string,
  userId: string,
  reason: string,
  requiredApprovals: number,
  database: Db
): Promise<void> {
  try {
    const guardians = await database.recoveryGuardian.findMany({
      where: { userId, status: 'ACCEPTED' },
      orderBy: { createdAt: 'asc' },
    })
    if (guardians.length === 0) return

    const accountHint = await maskedAccountHint(userId, database)
    const expiresAt = new Date(
      Date.now() + REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    // A fresh decision token per request, stored as a digest. The guardian's
    // nomination token is replaced: it has already been spent proving they
    // accepted, and keeping one long-lived token alive for both roles widens
    // the window if it leaks from an email inbox.
    const withTokens = await Promise.all(
      guardians.map(async (guardian) => {
        if (guardian.guardianUserId) {
          return { ...guardian, inviteToken: null }
        }
        const decisionToken = generateRecoveryToken()
        await database.recoveryGuardian.update({
          where: { id: guardian.id },
          data: {
            inviteTokenHash: hashRecoveryToken(decisionToken),
            inviteExpiresAt: expiresAt
              ? new Date(expiresAt)
              : guardian.inviteExpiresAt,
          },
        })
        return { ...guardian, inviteToken: decisionToken }
      })
    )

    await notifyGuardiansOfRequest({
      requestId,
      userId,
      accountHint,
      reason,
      requiredApprovals,
      expiresAt,
      guardians: withTokens.map((g) => ({
        id: g.id,
        guardianUserId: g.guardianUserId,
        externalEmail: g.externalEmail,
        externalPhone: g.externalPhone,
        inviteToken: g.inviteToken,
      })),
    })
  } catch (err) {
    // Never let alerting break the request that is already open.
    logger.error('[Guardians] FAILED to alert guardians about a request', {
      requestId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── Guardian approval ──────────────────────────────────────────────────────

/**
 * Apply ONE guardian's decision to an open request.
 *
 * Both public approval entry points funnel through here, which is what makes
 * "approvals are independent and explicit, never automatic or bulk" a property
 * of the code's shape rather than a claim in a comment: the function takes
 * exactly one guardian's identity and one boolean, and there is no code path
 * anywhere that iterates guardians to decide for them.
 */
async function recordGuardianDecision(
  input: {
    requestId: string
    guardianId: string
    method: 'session' | 'external_token'
    approved: boolean
    note?: string
    ipAddress?: string
  },
  database: Db
): Promise<RecoveryRequestView> {
  const request = await database.recoveryRequest.findUnique({
    where: { id: input.requestId },
  })

  if (!request) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }

  if (request.status !== 'PENDING') {
    throw new RecoveryError(
      'request_closed',
      `This recovery request is no longer collecting approvals (status: ${request.status}).`,
      409
    )
  }

  if (request.expiresAt && request.expiresAt.getTime() < Date.now()) {
    await database.recoveryRequest.update({
      where: { id: request.id },
      data: { status: 'EXPIRED' },
    })
    throw new RecoveryError(
      'request_closed',
      'This recovery request has expired.',
      409
    )
  }

  const guardian = await database.recoveryGuardian.findUnique({
    where: { id: input.guardianId },
  })

  if (!guardian || guardian.userId !== request.userId) {
    throw new RecoveryError(
      'guardian_not_found',
      'That guardian is not a guardian for this account.',
      404
    )
  }

  // Only an explicitly accepted guardian may decide. A PENDING nomination is
  // exactly the "unwitting guardian" the issue rules out, so it cannot vote.
  if (guardian.status !== 'ACCEPTED') {
    throw new RecoveryError(
      'guardian_not_accepted',
      'This guardian has not accepted the nomination and cannot approve or decline.',
      409
    )
  }

  // A refusal is final, same as an approval — otherwise a guardian could be
  // re-asked indefinitely and an approval could follow a refusal, which would
  // make the recorded decision history a lie. The `@@unique([requestId,
  // guardianId])` constraint is the real race guard; this check only produces a
  // good error message.
  const existing = await database.recoveryApproval.findUnique({
    where: {
      requestId_guardianId: {
        requestId: input.requestId,
        guardianId: input.guardianId,
      },
    },
    select: { id: true },
  })
  if (existing) {
    throw new RecoveryError(
      'already_decided',
      'This guardian has already recorded a decision for this request.',
      409
    )
  }

  await database.recoveryApproval.create({
    data: {
      requestId: input.requestId,
      guardianId: input.guardianId,
      approved: input.approved,
      method: input.method,
      note: input.note ? sanitizeReason(input.note) : null,
      ipAddress: input.ipAddress ?? null,
    },
  })

  audit({
    type: input.approved ? 'RECOVERY_APPROVED' : 'RECOVERY_DECLINED',
    requestId: input.requestId,
    userId: request.userId,
    guardianId: input.guardianId,
    method: input.method,
  })

  if (!input.approved) {
    const view = await getRequestForGuardian(
      input.requestId,
      input.guardianId,
      database
    )
    return view
  }

  return maybeReachQuorum(input.requestId, request.userId, database)
}

/**
 * Count approvals and, the first time quorum is met, stamp the deadline.
 *
 * `quorumReachedAt` is written exactly once and `executeAfter` is derived from
 * the policy as it stands at that instant and then frozen onto the request row.
 * Nothing recomputes it later, which is what stops a policy edit from pulling a
 * live deadline forward — and what stops a *longer* delay from being shortened
 * either.
 */
async function maybeReachQuorum(
  requestId: string,
  userId: string,
  database: Db
): Promise<RecoveryRequestView> {
  const request = await database.recoveryRequest.findUnique({
    where: { id: requestId },
  })
  if (!request) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }
  if (request.quorumReachedAt) {
    // Quorum already reached. A further approval changes the tally but not the
    // deadline, which is already fixed.
    return getRequestForGuardian(requestId, '', database, true)
  }

  const policy = await getOrCreateRecoveryPolicy(userId, database)
  assertPolicyIsSane(policy)

  const approvals = await database.recoveryApproval.count({
    where: { requestId, approved: true },
  })

  if (approvals < policy.requiredApprovals) {
    return getRequestForGuardian(requestId, '', database, true)
  }

  const quorumReachedAt = new Date()
  const executeAfter = new Date(
    quorumReachedAt.getTime() + policy.recoveryDelayHours * 60 * 60 * 1000
  )

  // Conditional write: `quorumReachedAt: null` means whichever approval wins
  // this race stamps the deadline and every concurrent loser observes the row
  // already stamped, so the deadline is computed once and only once even under
  // parallel approvals.
  const claimed = await database.recoveryRequest.updateMany({
    where: { id: requestId, quorumReachedAt: null, status: 'PENDING' },
    data: {
      status: 'QUORUM_REACHED',
      quorumReachedAt,
      executeAfter,
      requiredApprovals: policy.requiredApprovals,
      recoveryDelayHours: policy.recoveryDelayHours,
    },
  })

  if (claimed.count === 0) {
    return getRequestForGuardian(requestId, '', database, true)
  }

  audit({
    type: 'RECOVERY_QUORUM_REACHED',
    requestId,
    userId,
    requiredApprovals: policy.requiredApprovals,
    recoveryDelayHours: policy.recoveryDelayHours,
    executeAfter: executeAfter.toISOString(),
  })

  // Last warning before access changes hands. The owner is told the exact
  // deadline AND that they can still cancel with no guardian agreement.
  void notifyQuorumReached({
    requestId,
    userId,
    requiredApprovals: policy.requiredApprovals,
    executeAfter: executeAfter.toISOString(),
  })

  logger.warn('[Guardians] Recovery quorum reached; delay window open', {
    requestId,
    userId,
    requiredApprovals: policy.requiredApprovals,
    executeAfter: executeAfter.toISOString(),
  })

  return getRequestForGuardian(requestId, '', database, true)
}

/**
 * Read a request back for a response body. `guardianId` narrows the visible
 * approval list to that guardian's own decision when the caller is a guardian
 * rather than the owner — guardians can see that a request exists and how far
 * along it is, but not who else has been asked or what they said.
 */
async function getRequestForGuardian(
  requestId: string,
  guardianId: string,
  database: Db,
  ownerView = false
): Promise<RecoveryRequestView> {
  const row = await fetchRequestRow(requestId, database)
  if (!row) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }

  if (ownerView) {
    return toRequestView(row, row.approvals)
  }

  return toRequestView(
    row,
    row.approvals.filter((a) => a.guardianId === guardianId)
  )
}

/**
 * A platform guardian's decision, proven by their own authenticated session.
 * The service re-checks that the session's user really is this guardian's
 * nominated user — the route's `requireAuth` is necessary but not sufficient.
 */
export async function approveRecoveryAsGuardian(
  input: {
    requestId: string
    actorUserId: string
    approved: boolean
    note?: string
    ipAddress?: string
  },
  database: Db = db
): Promise<RecoveryRequestView> {
  const request = await database.recoveryRequest.findUnique({
    where: { id: input.requestId },
    select: { userId: true },
  })
  if (!request) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }

  const guardian = await database.recoveryGuardian.findFirst({
    where: {
      userId: request.userId,
      guardianUserId: input.actorUserId,
      status: 'ACCEPTED',
    },
  })

  if (!guardian) {
    // Same error whether the caller is a stranger or a guardian for a different
    // account: the distinction is not useful to an attacker and would confirm
    // that a recovery is in progress for a given wallet.
    throw new RecoveryError(
      'guardian_not_found',
      'You are not an accepted guardian for this recovery request.',
      404
    )
  }

  const view = await recordGuardianDecision(
    {
      requestId: input.requestId,
      guardianId: guardian.id,
      method: 'session',
      approved: input.approved,
      note: input.note,
      ipAddress: input.ipAddress,
    },
    database
  )

  return view
}

/**
 * An external contact's decision, proven by the invite token they were sent.
 *
 * The token identifies the guardian, so a guardian can never decide on another's
 * behalf, and it is not consumed here — an external guardian may need to look at
 * the request before deciding. What stops a replay is the one-decision-per-
 * (request, guardian) row, which a second use of the same token collides with.
 */
export async function approveRecoveryAsExternalGuardian(
  input: {
    requestId: string
    token: string
    approved: boolean
    note?: string
    ipAddress?: string
  },
  database: Db = db
): Promise<RecoveryRequestView> {
  const request = await database.recoveryRequest.findUnique({
    where: { id: input.requestId },
    select: { userId: true },
  })
  if (!request) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }

  const guardian = await findGuardianByToken(input.token, database)

  if (!guardian || guardian.userId !== request.userId) {
    throw new RecoveryError(
      'guardian_not_found',
      'Invalid approval token for this recovery request.',
      404
    )
  }

  return recordGuardianDecision(
    {
      requestId: input.requestId,
      guardianId: guardian.id,
      method: 'external_token',
      approved: input.approved,
      note: input.note,
      ipAddress: input.ipAddress,
    },
    database
  )
}

/** Requests this user is an accepted guardian for and has not yet decided. */
export async function listRequestsAwaitingGuardian(
  guardianUserId: string,
  database: Db = db
): Promise<RecoveryRequestView[]> {
  const guardians = await database.recoveryGuardian.findMany({
    where: { guardianUserId, status: 'ACCEPTED' },
    select: { id: true, userId: true },
  })

  if (guardians.length === 0) return []

  const requests = await database.recoveryRequest.findMany({
    where: {
      userId: { in: guardians.map((g) => g.userId) },
      status: 'PENDING',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
    include: {
      approvals: {
        where: { guardianId: { in: guardians.map((g) => g.id) } },
        select: {
          guardianId: true,
          approved: true,
          decidedAt: true,
          method: true,
        },
      },
    },
  })

  return requests.map((r) => toRequestView(r, r.approvals))
}

// ─── Cancellation ───────────────────────────────────────────────────────────

/**
 * Stop a pending recovery. Owner-only, unilateral, immediate.
 *
 * Deliberately the easiest action in the feature: no quorum, no guardian
 * consent, no delay, and allowed right up to the moment execution wins the
 * race. The conditional update is the whole safety argument — it matches on
 * `status IN (PENDING, QUORUM_REACHED)`, so a cancellation that lands
 * concurrently with execution cannot resurrect a dead request, and whichever
 * write hits first is the one that counts.
 */
export async function cancelRecovery(
  input: { requestId: string; userId: string },
  database: Db = db
): Promise<RecoveryRequestView> {
  const request = await database.recoveryRequest.findUnique({
    where: { id: input.requestId },
  })

  if (!request) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }
  if (request.userId !== input.userId) {
    throw new RecoveryError(
      'not_request_owner',
      'This recovery request belongs to another account.',
      403
    )
  }

  const cancelledAt = new Date()

  const cancelled = await database.recoveryRequest.updateMany({
    where: { id: request.id, status: { in: OPEN_REQUEST_STATUSES } },
    data: { status: 'CANCELLED', cancelledAt },
  })

  if (cancelled.count === 0) {
    // Either it was already closed, or execution won the race microseconds
    // ago. Both mean the same thing to this caller: it is over, and it was not
    // us who ended it.
    const current = await database.recoveryRequest.findUnique({
      where: { id: request.id },
    })
    throw new RecoveryError(
      'request_closed',
      `This recovery request is already ${current?.status ?? 'closed'} and can no longer be cancelled.`,
      409
    )
  }

  audit({
    type: 'RECOVERY_CANCELLED',
    requestId: request.id,
    userId: input.userId,
    quorumReachedAt: request.quorumReachedAt?.toISOString() ?? null,
  })

  void notifyRecoveryCancelled({
    requestId: request.id,
    userId: input.userId,
    cancelledAt: cancelledAt.toISOString(),
  })

  logger.warn('[Guardians] Recovery cancelled by the account owner', {
    requestId: request.id,
    userId: input.userId,
    quorumHadBeenReached: Boolean(request.quorumReachedAt),
  })

  const updated = await fetchRequestRow(request.id, database)
  return toRequestView(updated!, updated!.approvals)
}

// ─── Execution ──────────────────────────────────────────────────────────────

export interface ExecutionOutcome {
  id: string
  userId: string
  status: RequestStatus
  revokedSessions: number
  executedAt: string | null
  executeAfter: string | null
  /** False when the request was not due, or another actor got there first. */
  executed: boolean
}

/**
 * Revoke EVERY live session, destroying refresh material as it goes.
 *
 * Uses revokeSession() rather than a bare updateMany because #472 made refresh
 * tokens rotating and destructive-on-revoke: clearing only `revokedAt` would
 * leave a refresh token issued before the recovery valid, and an attacker who
 * triggered the recovery would keep the account.
 *
 * Auth on this platform is wallet-signature based, so there is no password or
 * shared secret to rotate. Destroying every session and every refresh token IS
 * the credential reset: the only thing that can mint a new session is
 * possession of the wallet, which the recovery does not confer.
 */
async function revokeAllSessions(
  userId: string,
  database: Db = db
): Promise<number> {
  const sessions = await database.session.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, deviceType: true, approxLocation: true },
  })

  for (const session of sessions) {
    try {
      await revokeSession(session.id, 'account_recovery', {
        userId,
        deviceType: session.deviceType,
        approxLocation: session.approxLocation,
      })
    } catch (err) {
      // Keep going: one session that fails to revoke must not strand the rest
      // of the account in a half-recovered state. The request still completes,
      // and the failure is loud in the log and in the audit payload.
      logger.error('[Guardians] Failed to revoke a session during recovery', {
        userId,
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return sessions.length
}

/**
 * Execute a recovery whose delay has elapsed. PLATFORM-SIDE ONLY.
 *
 * There is deliberately no HTTP route that calls this. A route would be
 * reachable only by an authenticated user of the account being recovered — and
 * the moment it succeeded, every one of their sessions would be revoked, so
 * nobody could ever call it. The sweep in src/jobs/guardianRecoverySweep.ts is
 * the only caller, and it passes a `now` it controls.
 *
 * Re-checks `executeAfter` even though the query already filtered on it, so that
 * a bug in the caller's filter cannot shorten the mandatory delay.
 */
export async function executeRecovery(
  requestId: string,
  now: Date = new Date(),
  database: Db = db
): Promise<ExecutionOutcome> {
  const request = await database.recoveryRequest.findUnique({
    where: { id: requestId },
  })

  if (!request) {
    throw new RecoveryError(
      'request_not_found',
      'Recovery request not found.',
      404
    )
  }

  const notExecuted = (): ExecutionOutcome => ({
    id: request.id,
    userId: request.userId,
    status: request.status as RequestStatus,
    revokedSessions: 0,
    executedAt: null,
    executeAfter: request.executeAfter?.toISOString() ?? null,
    executed: false,
  })

  if (request.status !== 'QUORUM_REACHED') {
    return notExecuted()
  }
  if (!request.executeAfter) {
    // Reached QUORUM_REACHED without a deadline. Structurally impossible via
    // the service, so treat it as a refusal rather than a recovery.
    logger.error(
      '[Guardians] Refusing to execute a recovery with no deadline',
      {
        requestId,
      }
    )
    return notExecuted()
  }
  if (request.executeAfter.getTime() > now.getTime()) {
    return notExecuted()
  }
  if (request.expiresAt && request.expiresAt.getTime() < now.getTime()) {
    await database.recoveryRequest.updateMany({
      where: { id: request.id, status: 'QUORUM_REACHED' },
      data: { status: 'EXPIRED' },
    })
    audit({ type: 'RECOVERY_EXPIRED', requestId, userId: request.userId })
    return notExecuted()
  }

  const executedAt = new Date()

  // The CAS that decides the cancel-vs-execute race. Matches on the exact
  // deadline we verified, so a cancellation landing first (status no longer
  // QUORUM_REACHED) loses cleanly.
  const claimed = await database.recoveryRequest.updateMany({
    where: {
      id: request.id,
      status: 'QUORUM_REACHED',
      executeAfter: { lte: now },
    },
    data: { status: 'COMPLETED', executedAt },
  })

  if (claimed.count === 0) {
    return notExecuted()
  }

  const revokedSessions = await revokeAllSessions(request.userId, database)

  audit({
    type: 'RECOVERY_COMPLETED',
    requestId,
    userId: request.userId,
    revokedSessions,
    quorumReachedAt: request.quorumReachedAt?.toISOString() ?? null,
  })

  void notifyRecoveryCompleted({
    requestId,
    userId: request.userId,
    revokedSessions,
    executedAt: executedAt.toISOString(),
  })

  logger.warn('[Guardians] Recovery executed; all sessions revoked', {
    requestId,
    userId: request.userId,
    revokedSessions,
  })

  return {
    id: request.id,
    userId: request.userId,
    status: 'COMPLETED',
    revokedSessions,
    executedAt: executedAt.toISOString(),
    executeAfter: request.executeAfter.toISOString(),
    executed: true,
  }
}

/** Mark requests that aged out without ever reaching quorum. */
export async function expireStaleRequests(
  now: Date = new Date(),
  database: Db = db
): Promise<number> {
  const stale = await database.recoveryRequest.findMany({
    where: {
      status: { in: OPEN_REQUEST_STATUSES },
      expiresAt: { lt: now },
    },
    select: { id: true, userId: true },
  })

  if (stale.length === 0) return 0

  const result = await database.recoveryRequest.updateMany({
    where: {
      id: { in: stale.map((r) => r.id) },
      status: { in: OPEN_REQUEST_STATUSES },
    },
    data: { status: 'EXPIRED' },
  })

  for (const row of stale) {
    audit({ type: 'RECOVERY_EXPIRED', requestId: row.id, userId: row.userId })
  }

  return result.count
}
