/**
 * The prioritized dispatcher (#325): claims durable outbox intents and turns
 * them into real Stellar submissions, with retry/backoff, fee-bump-on-
 * congestion, per-signer serialization, and a compliance halt guard.
 *
 * Two entry points:
 *  - dispatchOne(opId)   — claim-and-submit ONE specific PENDING op inline,
 *                          awaited by synchronous callers (deposit/withdraw
 *                          routes, referral payout) that need the result now.
 *  - runDispatchSweep()  — the background pass: claims whatever PENDING
 *                          backlog exists (crash recovery, retries whose
 *                          backoff has elapsed, and any genuinely
 *                          fire-and-forget op such as an agent rebalance),
 *                          priority-ordered, and reconciles SUBMITTED ops
 *                          that have gone quiet too long.
 *
 * Both paths converge on submitClaimedOp — there is exactly one code path
 * that ever calls src/outbox/executors.ts.
 */

import { logger } from '../utils/logger'
import { config } from '../config/env'
import { alertingService } from '../services/alerting'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { TransactionResult } from '../stellar/types'
import { getSignerLock } from './signerLock'
import { resolveSignerPublicKey, executeOutboxPayload } from './executors'
import { sortForDispatch } from './stateMachine'
import { OutboxOpRecord } from './types'
import {
  claimOp,
  findClaimableOps,
  findStuckSubmittedOps,
  getOp,
  getQueueStats,
  isUserHalted,
  markConfirmed,
  markFailedOrRetry,
  markFailedTerminal,
  mirrorLinkedTransaction,
  returnStuckOpToPending,
} from './service'
import {
  recordOutboxOp,
  recordOutboxFeeBump,
  recordOutboxLatency,
  updateOutboxQueueDepth,
  updateOutboxStuckSubmitted,
} from '../utils/metrics'

function signerLock() {
  return getSignerLock(
    config.outbox.globalMaxInFlight,
    config.outbox.perAccountMaxInFlight
  )
}

/**
 * Fee multiplier for a submission, derived from how many attempts have
 * already been made. Compounds up to feeBumpMaxAttempts, matching the
 * documented cap in docs/OUTBOX.md.
 */
function computeFeeMultiplier(attempts: number): number {
  const bumps = Math.min(
    Math.max(attempts - 1, 0),
    config.outbox.feeBumpMaxAttempts
  )
  return config.outbox.feeBumpMultiplier ** bumps
}

async function onTerminalFailure(
  op: OutboxOpRecord,
  errorMessage: string
): Promise<void> {
  logger.error('[Outbox] Op permanently FAILED', {
    opId: op.id,
    kind: op.kind,
    userId: op.userId,
    attempts: op.attempts,
    error: errorMessage,
  })

  await alertingService
    .emit({
      title: `Outbox op permanently failed: ${op.kind}`,
      description: `Outbox op ${op.id} (${op.kind}, priority ${op.priority}) for user ${op.userId} failed after ${op.attempts} attempts: ${errorMessage}`,
      severity: 'critical',
      component: 'outbox',
      metadata: { opId: op.id, kind: op.kind, userId: op.userId },
    })
    .catch((err: unknown) =>
      logger.error('[Outbox] Failed to emit terminal-failure alert', { err })
    )

  await publishUserEvent(
    op.userId,
    EVENT_TYPE_TOPIC['outbox.op_failed'],
    'outbox.op_failed',
    {
      opId: op.id,
      kind: op.kind,
      userId: op.userId,
      attempts: op.attempts,
      error: errorMessage,
    }
  ).catch(() => {})
}

/**
 * Submit an already-claimed (status=SUBMITTED in the DB) op. Resolves with
 * the on-chain result whether the network accepted or rejected it — a
 * resolved `status: 'failed'` (a vault-contract precondition failure, not a
 * transient error) is recorded as terminally FAILED but NOT retried and NOT
 * thrown, matching the single-attempt behavior the deposit/withdraw routes
 * had before #325. Only an actual exception (network/simulation error) goes
 * through the retry/backoff pipeline and is re-thrown, so a synchronous
 * caller's existing error handling is unaffected by the outbox underneath it.
 */
async function submitClaimedOp(op: OutboxOpRecord): Promise<TransactionResult> {
  const feeMultiplier = computeFeeMultiplier(op.attempts)
  const lock = signerLock()

  try {
    const result = await lock.withLock(op.signerPublicKey!, () =>
      executeOutboxPayload(op.payload, feeMultiplier)
    )

    if (!result.status || result.status === 'success') {
      await markConfirmed(op.id, result.hash)
      await mirrorLinkedTransaction(op.payload, {
        txHash: result.hash,
        status: 'CONFIRMED',
      })
      recordOutboxOp(op.kind, op.priority, 'confirmed')
      recordOutboxLatency(op.kind, (Date.now() - op.createdAt.getTime()) / 1000)
      logger.info('[Outbox] Op confirmed', {
        opId: op.id,
        kind: op.kind,
        txHash: result.hash,
        attempts: op.attempts,
      })
    } else {
      await markFailedTerminal(
        op.id,
        result.hash,
        'On-chain submission returned status=failed'
      )
      await mirrorLinkedTransaction(op.payload, {
        txHash: result.hash,
        status: 'FAILED',
      })
      recordOutboxOp(op.kind, op.priority, 'failed')
      logger.warn('[Outbox] Op rejected on-chain (terminal, not retried)', {
        opId: op.id,
        kind: op.kind,
        txHash: result.hash,
      })
      await onTerminalFailure(op, 'On-chain submission returned status=failed')
    }

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const { terminal } = await markFailedOrRetry(op, message)
    recordOutboxOp(op.kind, op.priority, terminal ? 'failed' : 'retry')

    if (terminal) {
      await mirrorLinkedTransaction(op.payload, { status: 'FAILED' })
      await onTerminalFailure(op, message)
    } else {
      logger.warn('[Outbox] Op submit failed — retriable', {
        opId: op.id,
        kind: op.kind,
        attempts: op.attempts,
        error: message,
      })
    }

    throw err
  }
}

/**
 * Claim-and-submit one specific PENDING op inline. Used by callers that want
 * the on-chain result synchronously (deposit/withdraw, referral payout).
 *
 * Throws if the op cannot be claimed (already claimed by a concurrent
 * dispatcher pass, the user is halted, or submission fails) — callers treat
 * that exactly as they treat a direct executeWriteContractCall failure today,
 * except the durable OutboxOp record now survives the failure for the
 * background sweep or an admin force-retry.
 */
export async function dispatchOne(opId: string): Promise<TransactionResult> {
  const op = await getOp(opId)
  if (!op) throw new Error(`Outbox op ${opId} not found`)

  if (op.status === 'CONFIRMED' && op.txHash) {
    return { hash: op.txHash, status: 'success' }
  }
  if (op.status !== 'PENDING') {
    throw new Error(`Outbox op ${opId} is not PENDING (status=${op.status})`)
  }

  if (await isUserHalted(op.userId)) {
    throw new Error(
      `Outbox op ${opId} not dispatched: user ${op.userId} is frozen`
    )
  }

  const signerPublicKey = await resolveSignerPublicKey(op.payload, op.userId)
  const claimed = await claimOp(opId, signerPublicKey)
  if (!claimed) {
    const latest = await getOp(opId)
    if (latest?.status === 'CONFIRMED' && latest.txHash) {
      return { hash: latest.txHash, status: 'success' }
    }
    throw new Error(
      `Outbox op ${opId} could not be claimed (status=${latest?.status ?? 'unknown'})`
    )
  }

  return submitClaimedOp(claimed)
}

/**
 * Non-blocking fire-and-forget dispatch: enqueue is already durable, so the
 * caller (the agent loop, for a LOW-priority rebalance) does not need to
 * await the on-chain round trip at all — the background sweep will pick the
 * op up on its own cadence, respecting priority ordering, if this opportunistic
 * attempt doesn't win the claim race first.
 */
export function dispatchInBackground(opId: string): void {
  dispatchOne(opId).catch((err) => {
    logger.warn('[Outbox] Background dispatch attempt failed (retriable)', {
      opId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/** Move ops SUBMITTED-but-unconfirmed past the timeout back into the retry pipeline. */
async function reconcileStuckSubmitted(): Promise<void> {
  const stuck = await findStuckSubmittedOps(config.outbox.submittedTimeoutMs)
  updateOutboxStuckSubmitted(stuck.length)

  for (const op of stuck) {
    if (op.attempts >= config.outbox.feeBumpMaxAttempts) {
      const { terminal } = await markFailedOrRetry(
        { id: op.id, attempts: config.outbox.maxAttempts },
        `Unconfirmed after ${config.outbox.feeBumpMaxAttempts} fee-bump attempts (submittedAt=${op.submittedAt?.toISOString()})`
      )
      recordOutboxOp(op.kind, op.priority, terminal ? 'failed' : 'retry')
      if (terminal) await onTerminalFailure(op, 'Fee-bump cap exceeded')
      continue
    }

    logger.warn(
      '[Outbox] Op unconfirmed past timeout — escalating to fee-bump retry',
      {
        opId: op.id,
        kind: op.kind,
        attempts: op.attempts,
        submittedAt: op.submittedAt,
      }
    )
    recordOutboxFeeBump(op.kind)
    await returnStuckOpToPending(op.id)
  }
}

/**
 * One background sweep: reconcile stuck SUBMITTED ops, then claim and submit
 * PENDING backlog in priority order (see src/outbox/stateMachine.ts —
 * CRITICAL withdrawals never wait behind a NORMAL/LOW wave).
 */
export async function runDispatchSweep(): Promise<void> {
  await reconcileStuckSubmitted()

  const stats = await getQueueStats()
  updateOutboxQueueDepth(stats)

  const claimable = sortForDispatch(
    await findClaimableOps(config.outbox.batchSize)
  )

  for (const op of claimable) {
    if (await isUserHalted(op.userId)) {
      logger.info('[Outbox] Skipping op for frozen user', {
        opId: op.id,
        userId: op.userId,
      })
      continue
    }

    let signerPublicKey: string
    try {
      signerPublicKey = await resolveSignerPublicKey(op.payload, op.userId)
    } catch (err) {
      logger.error('[Outbox] Could not resolve signer for op', {
        opId: op.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    if (!signerLock().hasCapacity(signerPublicKey)) {
      continue // over the concurrency cap — left PENDING for the next sweep
    }

    const claimed = await claimOp(op.id, signerPublicKey)
    if (!claimed) continue // lost the claim race to another dispatch path

    // Bounded by the concurrency caps checked above — not literally awaited
    // per-op so one slow submission cannot stall the whole priority-ordered
    // batch behind it.
    submitClaimedOp(claimed).catch(() => {
      // Already logged/alerted inside submitClaimedOp.
    })
  }
}

let dispatcherHandle: NodeJS.Timeout | null = null

export function scheduleOutboxDispatcher(): NodeJS.Timeout {
  runDispatchSweep().catch((err) =>
    logger.error('[Outbox] Initial dispatch sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  )

  dispatcherHandle = setInterval(() => {
    runDispatchSweep().catch((err) =>
      logger.error('[Outbox] Dispatch sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }, config.outbox.dispatchIntervalMs)

  logger.info('[Outbox] Dispatcher scheduled', {
    intervalMs: config.outbox.dispatchIntervalMs,
  })
  return dispatcherHandle
}
