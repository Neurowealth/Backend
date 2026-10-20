/**
 * Pure state-machine + priority-ordering rules for the outbox (#325).
 *
 * No I/O, no Prisma import — this module is the single source of truth for
 * "is this transition legal" and "in what order should PENDING ops be
 * dispatched," and is exercised directly by
 * tests/unit/outbox/stateMachine.test.ts without a database.
 */

import { OutboxOpStatus, OutboxOpRecord, OutboxPriority } from './types'

/**
 * Legal transitions out of each status. PENDING is re-entrant (a transient
 * submit failure returns an op to PENDING with a backoff nextAttemptAt, so it
 * is re-claimed on a later dispatcher tick rather than living in a separate
 * "RETRYING" status).
 *
 * Reading the table: each key is the CURRENT status, and its array lists the
 * statuses the op is allowed to move to next. An empty array means the status
 * is terminal.
 */
const VALID_TRANSITIONS: Record<OutboxOpStatus, OutboxOpStatus[]> = {
  // Waiting to be dispatched. Can be claimed (SUBMITTED), cancelled by an
  // admin, or failed directly.
  PENDING: ['SUBMITTED', 'CANCELLED', 'FAILED'],
  // Claimed and (possibly) on-chain. Can confirm, be requeued for retry or
  // after a stuck-op timeout (PENDING), or fail permanently.
  SUBMITTED: ['CONFIRMED', 'PENDING', 'FAILED'],
  // Terminal: the op succeeded; nothing may follow.
  CONFIRMED: [],
  FAILED: ['PENDING'], // admin force-retry only (src/outbox/service.ts)
  // Terminal: cancelled before submission; nothing may follow.
  CANCELLED: [],
}

/**
 * Non-throwing check: is `from` -> `to` an allowed transition? Returns false
 * for any pair not listed in VALID_TRANSITIONS (including unknown statuses,
 * via the `?.` / `?? false` guards).
 */
export function canTransition(
  from: OutboxOpStatus,
  to: OutboxOpStatus
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * Throwing variant of canTransition. DB-facing code calls this before every
 * status write so an illegal move fails loudly instead of corrupting state.
 */
export function assertTransition(
  from: OutboxOpStatus,
  to: OutboxOpStatus
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal outbox transition: ${from} -> ${to}`)
  }
}

/** Lower number = dispatched first. */
export const PRIORITY_WEIGHT: Record<OutboxPriority, number> = {
  CRITICAL: 0,
  NORMAL: 1,
  LOW: 2,
}

/**
 * Ordering for claiming PENDING ops: priority first, then FIFO (oldest
 * createdAt first) within a priority tier.
 *
 * This is what keeps a CRITICAL withdrawal from starving behind a NORMAL or
 * LOW wave (e.g. a burst of agent rebalances or recurring-deposit runs): a
 * CRITICAL op sorts ahead of every NORMAL/LOW op regardless of how much
 * longer they have been queued. See
 * tests/unit/outbox/stateMachine.test.ts ("does not starve a CRITICAL op
 * behind a wave of NORMAL ops").
 */
export function compareForDispatch(
  a: Pick<OutboxOpRecord, 'priority' | 'createdAt'>,
  b: Pick<OutboxOpRecord, 'priority' | 'createdAt'>
): number {
  // Primary key: priority weight (negative => `a` sorts first).
  const weightDiff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
  if (weightDiff !== 0) return weightDiff
  // Tie-breaker: older op first (smaller timestamp => negative => `a` first).
  return a.createdAt.getTime() - b.createdAt.getTime()
}

/**
 * Return a new array sorted into dispatch order. Copies first (`[...ops]`)
 * so the caller's array is never mutated. The generic `T` lets callers pass
 * full OutboxOpRecords and get the same type back.
 */
export function sortForDispatch<
  T extends Pick<OutboxOpRecord, 'priority' | 'createdAt'>,
>(ops: T[]): T[] {
  return [...ops].sort(compareForDispatch)
}

/**
 * Full jitter exponential backoff (AWS-style): a random delay in
 * [0, base * 2^attempt], capped. `attempt` is the 1-indexed attempt number
 * that just failed.
 *
 * Note: the code uses `2 ** (attempt - 1)`, so the ceiling is actually
 * base * 2^(attempt - 1): the first failure (attempt 1) draws from
 * [0, base], the second from [0, 2 * base], and so on.
 *
 * `random` is injectable (defaults to Math.random) so tests can make the
 * result deterministic.
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  // Exponential ceiling for this attempt, clamped to maxMs. Math.max(0, ...)
  // keeps a bad `attempt` (0 or negative) from producing a fractional power.
  const capped = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  // "Full jitter": pick uniformly in [0, capped) rather than waiting the
  // whole ceiling, which spreads retries out and avoids thundering herds.
  return Math.floor(random() * capped)
}
