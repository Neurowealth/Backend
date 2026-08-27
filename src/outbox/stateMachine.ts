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
 */
const VALID_TRANSITIONS: Record<OutboxOpStatus, OutboxOpStatus[]> = {
  PENDING: ['SUBMITTED', 'CANCELLED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'PENDING', 'FAILED'],
  CONFIRMED: [],
  FAILED: ['PENDING'], // admin force-retry only (src/outbox/service.ts)
  CANCELLED: [],
}

export function canTransition(
  from: OutboxOpStatus,
  to: OutboxOpStatus
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

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
  const weightDiff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
  if (weightDiff !== 0) return weightDiff
  return a.createdAt.getTime() - b.createdAt.getTime()
}

export function sortForDispatch<
  T extends Pick<OutboxOpRecord, 'priority' | 'createdAt'>,
>(ops: T[]): T[] {
  return [...ops].sort(compareForDispatch)
}

/**
 * Full jitter exponential backoff (AWS-style): a random delay in
 * [0, base * 2^attempt], capped. `attempt` is the 1-indexed attempt number
 * that just failed.
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const capped = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.floor(random() * capped)
}
