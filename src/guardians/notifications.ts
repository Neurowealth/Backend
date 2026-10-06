/**
 * Out-of-band alerting for guardian recovery (#535).
 *
 * Everything here is deliberately LOUD and deliberately NON-BLOCKING:
 *
 * - Loud, because the whole security argument of this feature rests on the
 *   account owner learning that a recovery is in flight. A claimant who has
 *   social-engineered every guardian still cannot stop this alert, and the
 *   owner can cancel unilaterally at any point before execution. If these
 *   sends fail silently, the feature's safety property quietly evaporates, so
 *   every failure is logged loudly even though it is swallowed.
 *
 * - Non-blocking, because a mail provider outage must not be able to abort a
 *   security action. `initiateRecovery` has already opened the request by the
 *   time we are called; throwing here would leave a live recovery that the
 *   owner was never told about, which is strictly worse than a recovery with a
 *   degraded alert. So nothing in this module throws.
 *
 * Delivery channels, in the order they are attempted:
 *   1. In-app realtime event (`publishUserEvent`) — reaches the owner only if
 *      they have a live session, and is the only channel the attacker cannot
 *      intercept.
 *   2. Registered email, if the account has one on file.
 *   3. Registered phone over WhatsApp (this repo's only outbound phone
 *      transport). Skipped, not errored, when no number is on file.
 *
 * Tokens are never logged. Contact details are masked in log lines.
 */
import db from '../db'
import { logger } from '../utils/logger'
import { mailRegistry } from '../mail/mailProvider'
import { sendWhatsAppMessage } from '../utils/twilio-client'
import { publishUserEvent } from '../events/publisher'
import {
  renderGuardianApprovalRequest,
  renderGuardianInvite,
  renderRecoveryCancelledNotice,
  renderRecoveryCompletedAlert,
  renderRecoveryInitiatedAlert,
  renderRecoveryQuorumReachedAlert,
} from '../mail/templates'

type Db = typeof db

function appUrl(): string {
  return process.env.APP_URL || 'https://neurowealth.app'
}

/**
 * Mask for log lines and non-essential text. Deliberately coarse: enough to
 * correlate two log lines, not enough to be useful if a log store leaks.
 */
function mask(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length)
  const head = value.slice(0, 2)
  const tail = value.slice(-2)
  return `${head}${'*'.repeat(Math.max(value.length - 4, 1))}${tail}`
}

/** Email, best-effort. Never throws. */
async function trySendEmail(
  to: string | null | undefined,
  message: ReturnType<typeof renderRecoveryInitiatedAlert>,
  context: Record<string, unknown>
): Promise<boolean> {
  if (!to) return false
  try {
    await mailRegistry.send({ ...message, to })
    logger.info('[Guardians] Recovery alert emailed', {
      ...context,
      to: mask(to),
    })
    return true
  } catch (err) {
    logger.error('[Guardians] FAILED to email a recovery alert', {
      ...context,
      to: mask(to),
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/** WhatsApp, best-effort. Never throws. */
async function trySendWhatsApp(
  to: string | null | undefined,
  body: string,
  context: Record<string, unknown>
): Promise<boolean> {
  if (!to) return false
  try {
    await sendWhatsAppMessage({ to, body })
    logger.info('[Guardians] Recovery alert sent over WhatsApp', {
      ...context,
      to: mask(to),
    })
    return true
  } catch (err) {
    logger.error('[Guardians] FAILED to send a recovery alert over WhatsApp', {
      ...context,
      to: mask(to),
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/** Realtime push, best-effort. Never throws. */
async function tryPublish(
  userId: string,
  type: Parameters<typeof publishUserEvent>[2],
  payload: Record<string, unknown>,
  context: Record<string, unknown>
): Promise<boolean> {
  try {
    await publishUserEvent(userId, 'alerts', type, payload)
    return true
  } catch (err) {
    logger.error('[Guardians] FAILED to emit a recovery socket event', {
      ...context,
      type,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Resolve the owner's own contact details. Read fresh each time rather than
 * passed in, so a caller cannot accidentally alert a guardian's address.
 */
async function loadOwnerContact(
  userId: string,
  database: Db
): Promise<{ email: string | null; phone: string | null }> {
  try {
    const user = await database.user.findUnique({
      where: { id: userId },
      select: { email: true, phone: true },
    })
    return { email: user?.email ?? null, phone: user?.phone ?? null }
  } catch (err) {
    logger.error(
      '[Guardians] FAILED to load owner contact for a recovery alert',
      {
        userId,
        error: err instanceof Error ? err.message : String(err),
      }
    )
    return { email: null, phone: null }
  }
}

// ─── Owner-facing alerts ─────────────────────────────────────────────────────

/**
 * A recovery was opened against this account. Sent to the owner on all three
 * channels, unconditionally, whether or not the caller was the owner.
 */
export async function notifyRecoveryInitiated(
  input: {
    requestId: string
    userId: string
    reason: string
    requiredApprovals: number
    acceptedGuardians: number
  },
  database: Db = db
): Promise<void> {
  const { requestId, userId, reason, requiredApprovals, acceptedGuardians } =
    input
  const context = { requestId, userId }
  const contact = await loadOwnerContact(userId, database)

  // Realtime first: it is the channel an attacker cannot intercept, so if
  // anything else fails this is the one that still reached the owner.
  await tryPublish(
    userId,
    'security.recovery_initiated',
    {
      requestId,
      reason,
      requiredApprovals,
      acceptedGuardians,
      initiatedAt: new Date().toISOString(),
      cancelUrl: `${appUrl()}/account/recovery`,
    },
    context
  )

  const initiatedAt = new Date().toISOString()

  await trySendEmail(
    contact.email,
    renderRecoveryInitiatedAlert('', {
      reason,
      requiredApprovals,
      acceptedGuardians,
      initiateAt: initiatedAt,
    }),
    context
  )

  await trySendWhatsApp(
    contact.phone,
    `SECURITY: a request to recover access to your account was submitted at ${initiatedAt}. ` +
      `Reason given: ${reason}. Your ${requiredApprovals} guardian(s) have been contacted. ` +
      `If this was not you, cancel it here: ${appUrl()}/account/recovery. ` +
      `Cancellation is immediate and needs no guardian agreement. ` +
      `We never ask you to share codes or approve anything on someone else's behalf.`,
    context
  )
}

/**
 * Quorum was reached and the mandatory delay started. This is the last alert
 * before access changes hands, so it says so plainly and repeats that the
 * owner can still cancel.
 */
export async function notifyQuorumReached(
  input: {
    requestId: string
    userId: string
    requiredApprovals: number
    executeAfter: string
  },
  database: Db = db
): Promise<void> {
  const { requestId, userId, requiredApprovals, executeAfter } = input
  const context = { requestId, userId }
  const contact = await loadOwnerContact(userId, database)

  await tryPublish(
    userId,
    'security.recovery_quorum_reached',
    {
      requestId,
      requiredApprovals,
      executeAfter,
      cancelUrl: `${appUrl()}/account/recovery`,
    },
    context
  )

  await trySendEmail(
    contact.email,
    renderRecoveryQuorumReachedAlert('', {
      requiredApprovals,
      executeAfter,
    }),
    context
  )

  await trySendWhatsApp(
    contact.phone,
    `SECURITY: your recovery request now has ${requiredApprovals} guardian approval(s) and ` +
      `will take effect at ${executeAfter}, when every session on the account is revoked. ` +
      `You can still cancel it yourself right now: ${appUrl()}/account/recovery`,
    context
  )
}

/** The recovery executed and every session was revoked. */
export async function notifyRecoveryCompleted(
  input: {
    requestId: string
    userId: string
    revokedSessions: number
    executedAt: string
  },
  database: Db = db
): Promise<void> {
  const { requestId, userId, revokedSessions, executedAt } = input
  const context = { requestId, userId }
  const contact = await loadOwnerContact(userId, database)

  await tryPublish(
    userId,
    'security.recovery_completed',
    { requestId, revokedSessions, executedAt },
    context
  )

  await trySendEmail(
    contact.email,
    renderRecoveryCompletedAlert('', { revokedSessions, executedAt }),
    context
  )

  await trySendWhatsApp(
    contact.phone,
    `SECURITY: the recovery on your account completed at ${executedAt} and ` +
      `${revokedSessions} session(s) were revoked. Sign in again at ${appUrl()}/login. ` +
      `If you did not authorise this, rotate your guardian set and contact support immediately.`,
    context
  )
}

/** The owner cancelled their own request. */
export async function notifyRecoveryCancelled(
  input: { requestId: string; userId: string; cancelledAt: string },
  database: Db = db
): Promise<void> {
  const { requestId, userId, cancelledAt } = input
  const context = { requestId, userId }
  const contact = await loadOwnerContact(userId, database)

  await tryPublish(
    userId,
    'security.recovery_cancelled',
    { requestId, cancelledAt },
    context
  )

  await trySendEmail(
    contact.email,
    renderRecoveryCancelledNotice('', { cancelledAt }),
    context
  )
}

// ─── Guardian-facing alerts ──────────────────────────────────────────────────

/**
 * A newly nominated guardian is being asked to accept the role. Sent out of
 * band by the OWNER at nomination time, carrying the accept token. This is the
 * step that makes the nomination explicit: nothing is enrolled until the
 * guardian acts on this message themselves.
 */
export async function notifyGuardianInvitation(input: {
  guardianId: string
  userId: string
  accountHint: string
  inviteToken: string
  inviteExpiresAt: string
  externalEmail: string | null
  externalPhone: string | null
}): Promise<void> {
  const {
    guardianId,
    userId,
    accountHint,
    inviteToken,
    inviteExpiresAt,
    externalEmail,
    externalPhone,
  } = input

  const context = { guardianId, userId }
  const acceptUrl = `${appUrl()}/account/guardians/accept?token=${encodeURIComponent(inviteToken)}`

  await trySendEmail(
    externalEmail,
    renderGuardianInvite('', {
      accountHint,
      acceptUrl,
      expiresAt: inviteExpiresAt,
    }),
    context
  )

  await trySendWhatsApp(
    externalPhone,
    `${accountHint} has nominated you as a recovery guardian for their NeuroWealth account. ` +
      `Accept or decline here: ${acceptUrl} (expires ${inviteExpiresAt}). ` +
      `You are not being asked for any code or money, and accepting gives you no access to the account.`,
    context
  )
}

/**
 * A recovery is open and this guardian's decision is needed. External guardians
 * get a single-use link carrying their own token; platform guardians are asked
 * to sign in, because their identity is already proven by their session and no
 * second factor is needed.
 */
export async function notifyGuardiansOfRequest(input: {
  requestId: string
  userId: string
  accountHint: string
  reason: string
  requiredApprovals: number
  expiresAt: string
  guardians: Array<{
    id: string
    guardianUserId: string | null
    externalEmail: string | null
    externalPhone: string | null
    inviteToken: string | null
  }>
}): Promise<void> {
  const {
    requestId,
    userId,
    accountHint,
    reason,
    requiredApprovals,
    expiresAt,
    guardians,
  } = input

  await Promise.all(
    guardians.map(async (guardian) => {
      const context = { requestId, guardianId: guardian.id, userId }
      const base = `${appUrl()}/account/recovery/requests`

      if (guardian.guardianUserId) {
        // Platform guardian: prove who you are the way you always do.
        await tryPublish(
          guardian.guardianUserId,
          'security.guardian_approval_requested',
          {
            requestId,
            accountHint,
            reason,
            requiredApprovals,
            expiresAt,
            reviewUrl: `${base}/${requestId}`,
          },
          context
        )
        return
      }

      const token = guardian.inviteToken
      if (!token) {
        logger.error(
          '[Guardians] Cannot alert an external guardian: no token on file',
          context
        )
        return
      }

      const decideUrl = `${base}/${requestId}/decide?token=${encodeURIComponent(token)}`

      await trySendEmail(
        guardian.externalEmail,
        renderGuardianApprovalRequest('', {
          requestId,
          approveUrl: decideUrl,
          executeAfter: null,
          accountHint,
          reason,
          requiredApprovals,
          expiresAt,
        }),
        context
      )

      await trySendWhatsApp(
        guardian.externalPhone,
        `${accountHint} may need your help recovering their account (stated reason: ${reason}). ` +
          `Review and decide here: ${decideUrl} (expires ${expiresAt}). ` +
          `Approving only confirms you recognise them; we never ask for a code or payment.`,
        context
      )
    })
  )
}
