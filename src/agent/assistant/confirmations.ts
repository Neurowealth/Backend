/**
 * Assistant confirmation gate (#318).
 *
 * Generalizes src/whatsapp/pendingConfirmations.ts (the voice-command
 * confirmation handshake, #288) to any assistant channel and any action tool.
 * The load-bearing property is unchanged: a non-read-only tool call is parked
 * here and echoed to the user, and only executes on the user's next
 * affirmative reply — quoting the EXACT args that were confirmed, never a
 * re-derived or "close enough" set.
 *
 * In-memory and keyed by (channel, userId), matching the existing
 * pendingConfirmations store. A parked confirmation expires after a short TTL
 * so a stale "yes" long after the fact can never trigger a fund movement.
 */

export interface PendingToolConfirmation {
  toolName: string
  args: Record<string, unknown>
  /** Human-readable echo shown to the user. */
  summary: string
  /** Stable id for this specific proposed call — becomes the idempotency key. */
  callId: string
  expiresAt: number
}

const store = new Map<string, PendingToolConfirmation>()

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000 // 5 minutes

function key(channel: string, userId: string): string {
  return `${channel}:${userId}`
}

export function setPendingToolConfirmation(
  channel: string,
  userId: string,
  confirmation: Omit<PendingToolConfirmation, 'expiresAt'>,
  now: number = Date.now()
): void {
  store.set(key(channel, userId), {
    ...confirmation,
    expiresAt: now + CONFIRMATION_TTL_MS,
  })
}

/**
 * Return the live pending confirmation for (channel, userId), or null if none
 * exists or it has expired. Expired entries are evicted on read.
 */
export function getPendingToolConfirmation(
  channel: string,
  userId: string,
  now: number = Date.now()
): PendingToolConfirmation | null {
  const k = key(channel, userId)
  const pending = store.get(k)
  if (!pending) return null
  if (now >= pending.expiresAt) {
    store.delete(k)
    return null
  }
  return pending
}

export function clearPendingToolConfirmation(
  channel: string,
  userId: string
): void {
  store.delete(key(channel, userId))
}

/** Test seam. */
export function clearAllPendingToolConfirmations(): void {
  store.clear()
}

/**
 * Idempotency at the confirmation layer (#318): a duplicate delivery of the
 * SAME confirmed callId (a webhook retry, a doubled "yes") must not
 * re-execute. The underlying service calls each carry their own idempotency
 * key too (src/outbox/idempotency.ts) — this is a second, cheaper guard in
 * front of them, scoped to "was this exact confirmed proposal already acted
 * on" rather than "was this exact business record already submitted
 * on-chain."
 */
const executedCallIds = new Map<string, number>()

export function markCallExecuted(
  callId: string,
  now: number = Date.now()
): void {
  executedCallIds.set(callId, now + CONFIRMATION_TTL_MS)
}

export function wasCallExecuted(
  callId: string,
  now: number = Date.now()
): boolean {
  const expiresAt = executedCallIds.get(callId)
  if (expiresAt === undefined) return false
  if (now >= expiresAt) {
    executedCallIds.delete(callId)
    return false
  }
  return true
}

/** Affirmative reply to a pending confirmation ("yes", "confirm", "yeah"…). */
export function isAffirmativeReply(message: string): boolean {
  return /^\s*(yes|yep|yeah|yup|confirm|confirmed|ok|okay|sure|correct|do it|go ahead|proceed|y)\s*[.!]*\s*$/i.test(
    message
  )
}

/** Negative reply to a pending confirmation ("no", "cancel", "stop"…). */
export function isNegativeReply(message: string): boolean {
  return /^\s*(no|nope|nah|cancel|stop|abort|don'?t|never mind|nevermind|n)\s*[.!]*\s*$/i.test(
    message
  )
}
