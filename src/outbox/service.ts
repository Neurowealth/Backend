/**
 * DB-facing outbox operations (#325): transactional enqueue, atomic claim,
 * and the terminal/retry transitions the dispatcher drives ops through.
 *
 * Every write here goes through the pure rules in src/outbox/stateMachine.ts
 * first — this module is deliberately thin glue between that and Prisma.
 *
 * Lifecycle overview (see stateMachine.ts for the authoritative rules):
 *
 *   PENDING ──claimOp──▶ SUBMITTED ──markConfirmed──────────▶ CONFIRMED
 *      ▲                    │
 *      │                    ├─markFailedOrRetry (attempts left)─▶ PENDING (with backoff)
 *      │                    ├─markFailedOrRetry (exhausted)─────▶ FAILED
 *      │                    ├─markFailedTerminal (network rejected)▶ FAILED
 *      │                    └─returnStuckOpToPending (timeout)──▶ PENDING
 *      │
 *      ├─forceRetry (admin, from FAILED)
 *      └─cancelOp (admin) ─▶ CANCELLED
 */

import { Prisma, OutboxOpStatus as PrismaOutboxOpStatus } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config/env'
import { assertTransition, computeBackoffMs } from './stateMachine'
import {
  OutboxOpKind,
  OutboxOpActor,
  OutboxOpRecord,
  OutboxOpStatus,
  OutboxPayload,
  OutboxPriority,
  PRIORITY_BY_KIND,
} from './types'

// Either the global Prisma client or an interactive-transaction handle, so
// callers can run the same helper inside or outside a `db.$transaction`.
type DbClient = typeof db | Prisma.TransactionClient

/**
 * Map a raw Prisma OutboxOp row to the domain-level OutboxOpRecord.
 *
 * Prisma returns `kind`, `actor`, `priority`, `status` as its own generated
 * enum types (or plain strings) and `payload` as generic JSON; this narrows
 * them to the app's own union types. The casts are trusted because every
 * write path in this file only stores valid values.
 */
function toRecord(row: {
  id: string
  idempotencyKey: string
  userId: string
  kind: string
  actor: string
  payload: Prisma.JsonValue
  priority: string
  status: string
  txHash: string | null
  attempts: number
  nextAttemptAt: Date | null
  error: string | null
  submittedAt: Date | null
  confirmedAt: Date | null
  createdAt: Date
  updatedAt: Date
  signerPublicKey: string | null
}): OutboxOpRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    userId: row.userId,
    kind: row.kind as OutboxOpKind,
    actor: row.actor as OutboxOpActor,
    // JsonValue -> OutboxPayload goes through `unknown` because TS can't
    // verify the JSON shape; the payload is validated at enqueue time.
    payload: row.payload as unknown as OutboxPayload,
    priority: row.priority as OutboxPriority,
    status: row.status as OutboxOpStatus,
    txHash: row.txHash,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    error: row.error,
    submittedAt: row.submittedAt,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    signerPublicKey: row.signerPublicKey,
  }
}

/**
 * Write the durable intent. Call this INSIDE the same `db.$transaction` as
 * whatever business row the caller derives (a Transaction row, a
 * ReferralConversion leg, ...) — that is the atomicity guarantee #325 adds:
 * "intent persisted" and "business state written" commit or roll back
 * together.
 *
 * Idempotent by `idempotencyKey`: a caller that re-runs against the same
 * business record (e.g. a retried job tick) gets back the SAME op row rather
 * than a duplicate, so it is safe to call unconditionally.
 */
export async function enqueueOutboxOp(
  tx: DbClient,
  params: {
    idempotencyKey: string
    userId: string
    kind: OutboxOpKind
    actor: OutboxOpActor
    payload: OutboxPayload
    priority?: OutboxPriority
  }
): Promise<OutboxOpRecord> {
  // Look up first so a repeat call returns the existing op untouched.
  // (A concurrent insert with the same key would still be caught by the
  // unique constraint on idempotencyKey at the DB level.)
  const existing = await tx.outboxOp.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  })
  if (existing) {
    return toRecord(existing)
  }

  const created = await tx.outboxOp.create({
    data: {
      idempotencyKey: params.idempotencyKey,
      userId: params.userId,
      kind: params.kind,
      actor: params.actor,
      payload: params.payload as unknown as Prisma.InputJsonValue,
      // Fall back to the kind's default priority unless the caller overrides.
      priority: params.priority ?? PRIORITY_BY_KIND[params.kind],
      // New ops always start life as PENDING, awaiting the dispatcher.
      status: 'PENDING',
    },
  })
  return toRecord(created)
}

/**
 * Atomically claim a PENDING op for submission: PENDING -> SUBMITTED via a
 * conditional update. If two dispatchers (or a synchronous inline caller and
 * a background sweep) race for the same op, exactly one `updateMany` call
 * sees `count === 1`; the loser gets `null` back and simply moves on — see
 * tests/integration/outbox/dispatcher.integration.test.ts.
 */
export async function claimOp(
  opId: string,
  signerPublicKey: string
): Promise<OutboxOpRecord | null> {
  // Fail fast if the state machine ever stops allowing this transition.
  assertTransition('PENDING', 'SUBMITTED')

  // The `status: 'PENDING'` predicate is what makes this a compare-and-set:
  // the row only updates if nobody else has claimed it in the meantime.
  const result = await db.outboxOp.updateMany({
    where: { id: opId, status: 'PENDING' as PrismaOutboxOpStatus },
    data: {
      status: 'SUBMITTED' as PrismaOutboxOpStatus,
      // Each claim counts as an attempt; this also drives retry exhaustion
      // and the fee-bump multiplier on resubmission.
      attempts: { increment: 1 },
      submittedAt: new Date(),
      // Record which signer account this attempt is using.
      signerPublicKey,
    },
  })

  // Lost the race (or the op is no longer PENDING).
  if (result.count === 0) {
    return null
  }

  // updateMany doesn't return rows, so re-read the freshly claimed op.
  const row = await db.outboxOp.findUnique({ where: { id: opId } })
  return row ? toRecord(row) : null
}

/**
 * The network confirmed the op: SUBMITTED -> CONFIRMED. Stores the final
 * txHash and timestamp and clears any error left over from earlier retries.
 */
export async function markConfirmed(
  opId: string,
  txHash: string
): Promise<void> {
  assertTransition('SUBMITTED', 'CONFIRMED')
  await db.outboxOp.update({
    where: { id: opId },
    data: {
      status: 'CONFIRMED' as PrismaOutboxOpStatus,
      txHash,
      confirmedAt: new Date(),
      error: null,
    },
  })
}

/**
 * Persist the txHash as soon as it is known (before confirmation), so the
 * confirmation fallback in reconcileOutboxOpByTxHash can find the op if the
 * dispatcher crashes mid-flight. Conditional on SUBMITTED so it can't
 * overwrite an op that has already moved on.
 */
export async function recordSubmittedTxHash(
  opId: string,
  txHash: string
): Promise<void> {
  await db.outboxOp.updateMany({
    where: { id: opId, status: 'SUBMITTED' as PrismaOutboxOpStatus },
    data: { txHash },
  })
}

/**
 * Clear a stale txHash from a SUBMITTED op (#656): the network no longer
 * knows the hash (expired RPC window / never propagated), so the next
 * fee-bump retry must build a FRESH submission rather than re-polling or
 * re-bumping the same unconfirmable envelope. Returns false when the op
 * is no longer SUBMITTED (lost a race with another sweep path).
 */
export async function clearStaleSubmittedTxHash(
  opId: string
): Promise<boolean> {
  const result = await db.outboxOp.updateMany({
    where: { id: opId, status: 'SUBMITTED' as PrismaOutboxOpStatus },
    data: { txHash: null },
  })
  return result.count === 1
}

/**
 * A submit attempt failed. If attempts remain, return the op to PENDING with
 * a full-jitter backoff `nextAttemptAt` so the dispatcher retries it later;
 * once attempts are exhausted, move it to the terminal FAILED state instead.
 * Returns whether the op is now terminal.
 */
export async function markFailedOrRetry(
  op: Pick<OutboxOpRecord, 'id' | 'attempts'>,
  errorMessage: string
): Promise<{ terminal: boolean }> {
  // `attempts` was already incremented by claimOp, so it equals the number
  // of tries made so far, including the one that just failed.
  const terminal = op.attempts >= config.outbox.maxAttempts

  if (terminal) {
    // Out of retries: give up permanently.
    assertTransition('SUBMITTED', 'FAILED')
    await db.outboxOp.update({
      where: { id: op.id },
      data: {
        status: 'FAILED' as PrismaOutboxOpStatus,
        // Truncate so a huge error string can't bloat the row.
        error: errorMessage.slice(0, 2000),
      },
    })
    return { terminal: true }
  }

  // Retries remain: put the op back in the queue, delayed by the backoff.
  assertTransition('SUBMITTED', 'PENDING')
  const backoffMs = computeBackoffMs(
    op.attempts,
    config.outbox.backoffBaseMs,
    config.outbox.backoffMaxMs
  )
  await db.outboxOp.update({
    where: { id: op.id },
    data: {
      status: 'PENDING' as PrismaOutboxOpStatus,
      error: errorMessage.slice(0, 2000),
      // findClaimableOps skips the op until this time has passed.
      nextAttemptAt: new Date(Date.now() + backoffMs),
    },
  })
  return { terminal: false }
}

/**
 * The on-chain submission resolved (no exception) but the network itself
 * rejected the operation (TransactionResult.status === 'failed') — e.g. a
 * vault-contract precondition failure. This is not a transient
 * network/congestion error, so unlike markFailedOrRetry it does not retry:
 * it records the txHash for audit and moves straight to the terminal FAILED
 * state, matching the single-attempt behavior the deposit/withdraw routes
 * had before #325.
 */
export async function markFailedTerminal(
  opId: string,
  txHash: string,
  errorMessage: string
): Promise<void> {
  assertTransition('SUBMITTED', 'FAILED')
  await db.outboxOp.update({
    where: { id: opId },
    data: {
      status: 'FAILED' as PrismaOutboxOpStatus,
      txHash, // kept for audit even though the op failed
      error: errorMessage.slice(0, 2000),
    },
  })
}

/** Admin-only: force a FAILED op back to PENDING, clearing backoff. */
export async function forceRetry(opId: string): Promise<OutboxOpRecord> {
  const op = await db.outboxOp.findUnique({ where: { id: opId } })
  if (!op) throw new Error(`Outbox op ${opId} not found`)
  // Let the state machine decide whether this op's current status may go
  // back to PENDING (e.g. reject CONFIRMED or CANCELLED ops).
  assertTransition(op.status as OutboxOpStatus, 'PENDING')

  const updated = await db.outboxOp.update({
    where: { id: opId },
    data: {
      status: 'PENDING' as PrismaOutboxOpStatus,
      error: null,
      // null = immediately eligible, no backoff delay.
      nextAttemptAt: null,
    },
  })
  logger.info('[Outbox] Admin force-retry', { opId })
  return toRecord(updated)
}

/** Cancel an unsent op. Only PENDING ops can be cancelled — once SUBMITTED, it's on-chain. */
export async function cancelOp(opId: string): Promise<OutboxOpRecord> {
  // Conditional update again: cancelling only succeeds if the op is still
  // PENDING, so it can't race with a dispatcher that just claimed it.
  const result = await db.outboxOp.updateMany({
    where: { id: opId, status: 'PENDING' as PrismaOutboxOpStatus },
    data: { status: 'CANCELLED' as PrismaOutboxOpStatus },
  })
  if (result.count === 0) {
    // Nothing updated: work out why so the error message is useful.
    const existing = await db.outboxOp.findUnique({ where: { id: opId } })
    if (!existing) throw new Error(`Outbox op ${opId} not found`)
    throw new Error(
      `Outbox op ${opId} is ${existing.status}, not PENDING — only unsent ops can be cancelled`
    )
  }
  const row = await db.outboxOp.findUnique({ where: { id: opId } })
  logger.info('[Outbox] Admin cancel', { opId })
  return toRecord(row!) // non-null: the update above just matched this row
}

/** Fetch a single op by id, or null if it doesn't exist. */
export async function getOp(opId: string): Promise<OutboxOpRecord | null> {
  const row = await db.outboxOp.findUnique({ where: { id: opId } })
  return row ? toRecord(row) : null
}

/** Look up the op that produced a given on-chain transaction hash (txHash is unique). */
export async function findOpByTxHash(
  txHash: string
): Promise<OutboxOpRecord | null> {
  const row = await db.outboxOp.findUnique({ where: { txHash } })
  return row ? toRecord(row) : null
}

/** Optional filters and pagination for listOps. All fields are AND-ed together. */
export interface ListOpsFilter {
  status?: OutboxOpStatus
  kind?: OutboxOpKind
  priority?: OutboxPriority
  userId?: string
  limit?: number
  offset?: number
}

/**
 * Paginated op listing for the admin view, newest first. Returns the page
 * of ops plus the total count matching the filter (ignoring pagination).
 */
export async function listOps(
  filter: ListOpsFilter = {}
): Promise<{ ops: OutboxOpRecord[]; total: number }> {
  // Prisma ignores `undefined` fields, so unset filters simply don't apply.
  const where: Prisma.OutboxOpWhereInput = {
    status: filter.status as PrismaOutboxOpStatus | undefined,
    kind: filter.kind,
    priority: filter.priority,
    userId: filter.userId,
  }
  // Clamp pagination: default page size 50, between 1 and 500; offset >= 0.
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)

  // Run the page query and the count in parallel.
  const [rows, total] = await Promise.all([
    db.outboxOp.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    db.outboxOp.count({ where }),
  ])

  return { ops: rows.map(toRecord), total }
}

/** Queue depth by status/priority — feeds the admin throughput view + Prometheus gauge. */
export async function getQueueStats(): Promise<
  Array<{ status: OutboxOpStatus; priority: OutboxPriority; count: number }>
> {
  // One GROUP BY query instead of fetching rows and counting in JS.
  const grouped = await db.outboxOp.groupBy({
    by: ['status', 'priority'],
    _count: { _all: true },
  })
  return grouped.map((g) => ({
    status: g.status as OutboxOpStatus,
    priority: g.priority as OutboxPriority,
    count: g._count._all,
  }))
}

/**
 * PENDING ops eligible right now: never attempted, or past their backoff
 * window. Priority ordering is applied in JS via
 * src/outbox/stateMachine.ts#sortForDispatch rather than a DB ORDER BY on a
 * non-numeric enum, so the ordering rule stays in one pure, tested place.
 *
 * Note: `take: limit` is applied by the DB with no ORDER BY, so priority
 * sorting only reorders the batch returned here, not the whole backlog.
 */
export async function findClaimableOps(
  limit: number
): Promise<OutboxOpRecord[]> {
  const now = new Date()
  const rows = await db.outboxOp.findMany({
    where: {
      status: 'PENDING' as PrismaOutboxOpStatus,
      // Eligible if there's no backoff set, or the backoff has elapsed.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    take: limit,
  })
  return rows.map(toRecord)
}

/**
 * Escalation step for a SUBMITTED op stuck past the confirmation timeout:
 * return it to PENDING, immediately eligible for reclaim. The next claim
 * increments `attempts`, which is what drives the fee-bump multiplier on
 * resubmission (src/outbox/dispatcher.ts#computeFeeMultiplier).
 */
export async function returnStuckOpToPending(opId: string): Promise<void> {
  assertTransition('SUBMITTED', 'PENDING')
  // Conditional on SUBMITTED so we don't clobber an op that confirmed while
  // the sweep was deciding to requeue it.
  await db.outboxOp.updateMany({
    where: { id: opId, status: 'SUBMITTED' as PrismaOutboxOpStatus },
    data: {
      status: 'PENDING' as PrismaOutboxOpStatus,
      // Clear the old hash: the resubmission will produce a new one.
      txHash: null,
      // "Now" (rather than null) makes it claimable on the very next sweep.
      nextAttemptAt: new Date(),
    },
  })
}

/** SUBMITTED ops that have been quiet longer than the confirmation timeout. */
export async function findStuckSubmittedOps(
  timeoutMs: number
): Promise<OutboxOpRecord[]> {
  const cutoff = new Date(Date.now() - timeoutMs)
  const rows = await db.outboxOp.findMany({
    where: {
      status: 'SUBMITTED' as PrismaOutboxOpStatus,
      // Submitted at or before the cutoff = waiting longer than the timeout.
      submittedAt: { lte: cutoff },
    },
  })
  return rows.map(toRecord)
}

/**
 * Mirror a definitive outcome back onto the linked Transaction row
 * (DEPOSIT/WITHDRAW/REBALANCE/REFERRAL_REWARD payloads carry `transactionId`).
 *
 * This is what closes the loop for a NON-blocking dispatch (an agent
 * rebalance via dispatchInBackground) and for the crash-recovery case where
 * the background sweep — not the original synchronous caller, which may have
 * already returned an error response — is what eventually confirms an op.
 * Idempotent: safe to also run from a synchronous caller that just updated
 * the same row itself.
 */
export async function mirrorLinkedTransaction(
  payload: OutboxPayload,
  outcome: { txHash?: string; status: 'CONFIRMED' | 'FAILED' }
): Promise<void> {
  // Protection fund payouts have no Transaction row but need balance/claim
  // updates on confirmed delivery (#651).
  if (payload.method === 'protection_fund_payout') {
    if (outcome.status === 'CONFIRMED') {
      await db.protectionFundBalance.updateMany({
        where: { assetSymbol: payload.assetSymbol },
        data: { amount: { decrement: payload.amount } },
      })
      await db.coverageClaim.updateMany({
        where: { id: payload.claimId },
        data: { status: 'PAID' },
      })
    }
    return
  }
  // Some payload kinds have no linked Transaction row; nothing to mirror.
  if (!('transactionId' in payload)) return
  // updateMany (not update) so a missing row is a silent no-op, not a throw.
  await db.transaction.updateMany({
    where: { id: payload.transactionId },
    data: {
      txHash: outcome.txHash, // undefined -> Prisma leaves the column untouched
      status: outcome.status,
      confirmedAt: outcome.status === 'CONFIRMED' ? new Date() : null,
    },
  })
}

/**
 * Mirror the "submitted, awaiting confirmation" state onto the linked
 * Transaction row: store the txHash and mark it PENDING. Like
 * mirrorLinkedTransaction, a no-op for payloads without a `transactionId`.
 */
export async function mirrorPendingTransaction(
  payload: OutboxPayload,
  txHash: string
): Promise<void> {
  if (!('transactionId' in payload)) return
  await db.transaction.updateMany({
    where: { id: payload.transactionId },
    data: { txHash, status: 'PENDING' },
  })
}

/**
 * Confirmation fallback oracle (#325): called from src/stellar/events.ts on
 * the SAME `tx` handle that just confirmed a Transaction row by txHash. If a
 * SUBMITTED OutboxOp is still waiting on that hash — the dispatcher process
 * crashed after submitting but before observing its own confirmation — this
 * is what closes it out instead of leaving it SUBMITTED forever. A no-op
 * (0 rows) for any txHash with no matching op, e.g. legacy/manual
 * transactions never created through the outbox.
 */
export async function reconcileOutboxOpByTxHash(
  tx: DbClient,
  txHash: string
): Promise<void> {
  await tx.outboxOp.updateMany({
    // Only SUBMITTED ops are touched, so already-terminal ops stay as-is.
    where: { txHash, status: 'SUBMITTED' as PrismaOutboxOpStatus },
    data: {
      status: 'CONFIRMED' as PrismaOutboxOpStatus,
      confirmedAt: new Date(),
    },
  })
}

// Known non-user identifiers used as outbox `userId` for system-initiated ops.
// Treasury sweeps use 'SYSTEM'; wallet provisioning uses a CustodialWallet.id.
// These must never be resolved against the User table (#652).
export const SYSTEM_USER_IDS = new Set(['SYSTEM'])

/** The central freeze guard the dispatcher must consult before dispatching an op (#325). */
export async function isUserHalted(userId: string): Promise<boolean> {
  // System-initiated ops (treasury sweeps, sponsored-reserve provisioning, …)
  // carry ids that never resolve to a User row. Skip the lookup so they are
  // never silently dropped as if the owner were frozen (#652).
  if (SYSTEM_USER_IDS.has(userId)) return false

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  })
  // Only an explicit deactivation counts as halted. A missing row means the
  // userId belongs to a non-user entity (e.g. wallet id used in
  // ACCOUNT_PROVISION) and must not block the op (#652).
  return user?.isActive === false
}
