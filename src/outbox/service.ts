/**
 * DB-facing outbox operations (#325): transactional enqueue, atomic claim,
 * and the terminal/retry transitions the dispatcher drives ops through.
 *
 * Every write here goes through the pure rules in src/outbox/stateMachine.ts
 * first — this module is deliberately thin glue between that and Prisma.
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

type DbClient = typeof db | Prisma.TransactionClient

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
      priority: params.priority ?? PRIORITY_BY_KIND[params.kind],
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
  assertTransition('PENDING', 'SUBMITTED')

  const result = await db.outboxOp.updateMany({
    where: { id: opId, status: 'PENDING' as PrismaOutboxOpStatus },
    data: {
      status: 'SUBMITTED' as PrismaOutboxOpStatus,
      attempts: { increment: 1 },
      submittedAt: new Date(),
      signerPublicKey,
    },
  })

  if (result.count === 0) {
    return null
  }

  const row = await db.outboxOp.findUnique({ where: { id: opId } })
  return row ? toRecord(row) : null
}

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
 * A submit attempt failed. If attempts remain, return the op to PENDING with
 * a full-jitter backoff `nextAttemptAt` so the dispatcher retries it later;
 * once attempts are exhausted, move it to the terminal FAILED state instead.
 * Returns whether the op is now terminal.
 */
export async function markFailedOrRetry(
  op: Pick<OutboxOpRecord, 'id' | 'attempts'>,
  errorMessage: string
): Promise<{ terminal: boolean }> {
  const terminal = op.attempts >= config.outbox.maxAttempts

  if (terminal) {
    assertTransition('SUBMITTED', 'FAILED')
    await db.outboxOp.update({
      where: { id: op.id },
      data: {
        status: 'FAILED' as PrismaOutboxOpStatus,
        error: errorMessage.slice(0, 2000),
      },
    })
    return { terminal: true }
  }

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
      txHash,
      error: errorMessage.slice(0, 2000),
    },
  })
}

/** Admin-only: force a FAILED op back to PENDING, clearing backoff. */
export async function forceRetry(opId: string): Promise<OutboxOpRecord> {
  const op = await db.outboxOp.findUnique({ where: { id: opId } })
  if (!op) throw new Error(`Outbox op ${opId} not found`)
  assertTransition(op.status as OutboxOpStatus, 'PENDING')

  const updated = await db.outboxOp.update({
    where: { id: opId },
    data: {
      status: 'PENDING' as PrismaOutboxOpStatus,
      error: null,
      nextAttemptAt: null,
    },
  })
  logger.info('[Outbox] Admin force-retry', { opId })
  return toRecord(updated)
}

/** Cancel an unsent op. Only PENDING ops can be cancelled — once SUBMITTED, it's on-chain. */
export async function cancelOp(opId: string): Promise<OutboxOpRecord> {
  const result = await db.outboxOp.updateMany({
    where: { id: opId, status: 'PENDING' as PrismaOutboxOpStatus },
    data: { status: 'CANCELLED' as PrismaOutboxOpStatus },
  })
  if (result.count === 0) {
    const existing = await db.outboxOp.findUnique({ where: { id: opId } })
    if (!existing) throw new Error(`Outbox op ${opId} not found`)
    throw new Error(
      `Outbox op ${opId} is ${existing.status}, not PENDING — only unsent ops can be cancelled`
    )
  }
  const row = await db.outboxOp.findUnique({ where: { id: opId } })
  logger.info('[Outbox] Admin cancel', { opId })
  return toRecord(row!)
}

export async function getOp(opId: string): Promise<OutboxOpRecord | null> {
  const row = await db.outboxOp.findUnique({ where: { id: opId } })
  return row ? toRecord(row) : null
}

export async function findOpByTxHash(
  txHash: string
): Promise<OutboxOpRecord | null> {
  const row = await db.outboxOp.findUnique({ where: { txHash } })
  return row ? toRecord(row) : null
}

export interface ListOpsFilter {
  status?: OutboxOpStatus
  kind?: OutboxOpKind
  priority?: OutboxPriority
  userId?: string
  limit?: number
  offset?: number
}

export async function listOps(
  filter: ListOpsFilter = {}
): Promise<{ ops: OutboxOpRecord[]; total: number }> {
  const where: Prisma.OutboxOpWhereInput = {
    status: filter.status as PrismaOutboxOpStatus | undefined,
    kind: filter.kind,
    priority: filter.priority,
    userId: filter.userId,
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)

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
 */
export async function findClaimableOps(
  limit: number
): Promise<OutboxOpRecord[]> {
  const now = new Date()
  const rows = await db.outboxOp.findMany({
    where: {
      status: 'PENDING' as PrismaOutboxOpStatus,
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
  await db.outboxOp.updateMany({
    where: { id: opId, status: 'SUBMITTED' as PrismaOutboxOpStatus },
    data: {
      status: 'PENDING' as PrismaOutboxOpStatus,
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
      submittedAt: { lte: cutoff },
    },
  })
  return rows.map(toRecord)
}

/**
 * Mirror a definitive outcome back onto the linked Transaction row
 * (DEPOSIT/WITHDRAW/REBALANCE payloads carry `transactionId`; REFERRAL_REWARD
 * does not and is a no-op here — its caller updates its Transaction row
 * itself since it always awaits dispatchOne synchronously).
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
  if (!('transactionId' in payload)) return
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
    where: { txHash, status: 'SUBMITTED' as PrismaOutboxOpStatus },
    data: {
      status: 'CONFIRMED' as PrismaOutboxOpStatus,
      confirmedAt: new Date(),
    },
  })
}

/** The central freeze guard the dispatcher must consult before dispatching an op (#325). */
export async function isUserHalted(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  })
  return !user || user.isActive === false
}
