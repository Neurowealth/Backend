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
import db from '../db'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import {
  TransactionConfirmationTimeoutError,
  TransactionResult,
} from '../stellar/types'
import { getTransactionStatus } from '../stellar/client'
import { getSignerLock } from './signerLock'
import { resolveSignerPublicKey, executeOutboxPayload } from './executors'
import { sortForDispatch } from './stateMachine'
import { OutboxOpRecord } from './types'
import {
  claimOp,
  clearStaleSubmittedTxHash,
  findClaimableOps,
  findStuckSubmittedOps,
  getOp,
  getQueueStats,
  isUserHalted,
  markConfirmed,
  markFailedOrRetry,
  markFailedTerminal,
  mirrorLinkedTransaction,
  mirrorPendingTransaction,
  recordSubmittedTxHash,
  returnStuckOpToPending,
} from './service'
import {
  recordOutboxOp,
  recordOutboxFeeBump,
  recordOutboxLatency,
  updateOutboxQueueDepth,
  updateOutboxStuckSubmitted,
  recordOutboxLowDeferred,
  recordOutboxAggressiveFeeUsed,
  recordOutboxMaxFeeHit,
} from '../utils/metrics'
import {
  getFeeSnapshot,
  isStale as isFeeSnapshotStale,
} from '../stellar/feeOracle'

/**
 * Accessor for the shared per-signer concurrency limiter. Resolved on each
 * call (rather than cached at module load) so it always reflects the current
 * config. Limits apply both globally and per signer account, which keeps
 * submissions from one signer serialized (avoids sequence-number clashes).
 */
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
  // attempts is 1 on the first try (claimOp increments before submit), so
  // the first attempt gets 0 bumps (multiplier 1) and each retry adds one.
  const bumps = Math.min(
    Math.max(attempts - 1, 0),
    config.outbox.feeBumpMaxAttempts
  )
  return config.outbox.feeBumpMultiplier ** bumps
}

// Numeric ranking of the fee oracle's congestion levels so they can be
// compared with >= / <. Unknown levels are treated as 0 (lowest) by callers.
const CONGESTION_ORDER: Record<string, number> = {
  low: 0,
  elevated: 1,
  high: 2,
  severe: 3,
}

/**
 * Should this op be held back for now? Only LOW-priority ops are ever
 * deferred, and only while congestion is "high" or worse. The deferral is
 * bounded: once an op has waited longer than lowMaxDeferMs it is dispatched
 * regardless, so LOW work can't starve forever.
 */
function shouldDeferLowOp(op: OutboxOpRecord, congestion: string): boolean {
  if (op.priority !== 'LOW') return false
  if ((CONGESTION_ORDER[congestion] ?? 0) < CONGESTION_ORDER['high'])
    return false
  const ageMs = Date.now() - new Date(op.createdAt).getTime()
  // Waited too long already — stop deferring and let it through.
  if (ageMs > config.outbox.lowMaxDeferMs) return false
  return true
}

/**
 * Pick the base fee (before attempt-based bumps) from the current fee
 * snapshot. CRITICAL ops pay the "aggressive" fee once congestion reaches
 * "elevated"; everything else uses the normal recommended fee.
 */
function getBaseFeeForOp(op: OutboxOpRecord): {
  baseFee: number
  isAggressive: boolean
} {
  const snapshot = getFeeSnapshot()
  const level = snapshot.congestionLevel
  if (
    op.priority === 'CRITICAL' &&
    (CONGESTION_ORDER[level] ?? 0) >= CONGESTION_ORDER['elevated']
  ) {
    return { baseFee: snapshot.aggressiveBaseFee, isAggressive: true }
  }
  return { baseFee: snapshot.recommendedBaseFee, isAggressive: false }
}

/**
 * Side effects when an op reaches permanent FAILED: log it, raise a critical
 * alert, and notify the user via an event. The alert and event are
 * best-effort — their own failures are swallowed/logged so they can never
 * mask the original failure or crash the dispatcher.
 */
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
  // --- Fee calculation -----------------------------------------------------
  // Base fee from congestion/priority, scaled by the per-attempt bump
  // multiplier, then clamped to the absolute ceiling (maxAbsFee).
  const { baseFee, isAggressive } = getBaseFeeForOp(op)
  if (isAggressive) recordOutboxAggressiveFeeUsed()

  const attemptMultiplier = computeFeeMultiplier(op.attempts)
  const rawFee = baseFee * attemptMultiplier
  const effectiveFee = Math.min(rawFee, config.outbox.maxAbsFee)
  const hitCap = rawFee > config.outbox.maxAbsFee
  if (hitCap) {
    recordOutboxMaxFeeHit(op.priority)
    // A CRITICAL op being capped means it may be underpriced for the current
    // network, so page someone. The second argument is a dedupe key so the
    // alert isn't re-sent on every attempt.
    if (op.priority === 'CRITICAL') {
      await alertingService
        .emit(
          {
            title: 'Outbox fee cap hit on CRITICAL op',
            description: `CRITICAL op ${op.id} hit OUTBOX_MAX_ABS_FEE ${config.outbox.maxAbsFee} stroops (raw ${rawFee}). Submitting at cap.`,
            severity: 'critical',
            component: 'outbox',
            metadata: { opId: op.id, rawFee, cap: config.outbox.maxAbsFee },
          },
          'outbox:max-fee-hit'
        )
        .catch(() => {})
    }
  }
  // Contract expects multiplier relative to BASE_FEE (100 stroops)
  const feeMultiplier = Math.max(1, Math.round(effectiveFee / 100))
  const lock = signerLock()

  try {
    // Run the submission under the per-signer lock so concurrent ops from
    // the same signer account don't collide. The callback persists the
    // txHash as soon as it exists, so a crash mid-confirmation can still be
    // reconciled later.
    // (signerPublicKey is always set here: claimOp stored it at claim time.)
    const result = await lock.withLock(op.signerPublicKey!, () =>
      executeOutboxPayload(op.payload, feeMultiplier, (txHash) =>
        recordSubmittedTxHash(op.id, txHash)
      )
    )

    if (result.status === 'pending') {
      // Submitted but not yet confirmed. Leave the op SUBMITTED and keep the
      // hash; the stuck-op reconciler or the events oracle will resolve it.
      await recordSubmittedTxHash(op.id, result.hash)
      await mirrorPendingTransaction(op.payload, result.hash)
      logger.warn('[Outbox] Confirmation pending; preserving submitted hash', {
        opId: op.id,
        txHash: result.hash,
      })
    } else if (!result.status || result.status === 'success') {
      // Success path (a missing status is treated as success).
      await markConfirmed(op.id, result.hash)
      await mirrorLinkedTransaction(op.payload, {
        txHash: result.hash,
        status: 'CONFIRMED',
      })
      recordOutboxOp(op.kind, op.priority, 'confirmed')
      // End-to-end latency from enqueue to confirmation, in seconds.
      recordOutboxLatency(op.kind, (Date.now() - op.createdAt.getTime()) / 1000)
      logger.info('[Outbox] Op confirmed', {
        opId: op.id,
        kind: op.kind,
        txHash: result.hash,
        attempts: op.attempts,
      })
    } else {
      // The network resolved but rejected the op (status === 'failed').
      // Terminal and not retried; returned (not thrown) to the caller.
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
    // A confirmation timeout is not a failure: the tx was submitted and may
    // still land. Keep the hash, leave the op SUBMITTED, and report pending
    // rather than retrying (which could double-submit).
    if (err instanceof TransactionConfirmationTimeoutError) {
      await recordSubmittedTxHash(op.id, err.txHash)
      await mirrorPendingTransaction(op.payload, err.txHash)
      logger.warn(
        '[Outbox] Confirmation timed out; preserving submitted hash',
        {
          opId: op.id,
          txHash: err.txHash,
        }
      )
      return { hash: err.txHash, status: 'pending' }
    }

    // Any other exception: either schedule a retry with backoff or, if
    // attempts are exhausted, fail permanently.
    const { terminal } = await markFailedOrRetry(op, message)
    recordOutboxOp(op.kind, op.priority, terminal ? 'failed' : 'retry')

    if (terminal) {
      // No txHash is available on this path, hence only the status mirrors.
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

    // Re-throw so synchronous callers see the same error they would have
    // seen before the outbox existed.
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

  // Idempotent short-circuit: if it already confirmed (e.g. via the sweep),
  // return the existing result instead of erroring.
  if (op.status === 'CONFIRMED' && op.txHash) {
    return { hash: op.txHash, status: 'success' }
  }
  if (op.status !== 'PENDING') {
    throw new Error(`Outbox op ${opId} is not PENDING (status=${op.status})`)
  }

  // Compliance/freeze guard: never dispatch for a halted user.
  if (await isUserHalted(op.userId)) {
    throw new Error(
      `Outbox op ${opId} not dispatched: user ${op.userId} is frozen`
    )
  }

  // LOW deferral during high/severe congestion (bounded)
  try {
    const snap = getFeeSnapshot()
    if (shouldDeferLowOp(op, snap.congestionLevel)) {
      // Push nextAttemptAt out so the sweep also leaves it alone until then,
      // then throw so the inline caller knows it wasn't dispatched.
      const deferUntil = new Date(Date.now() + config.outbox.lowDeferMs)
      await db.outboxOp.update({
        where: { id: op.id },
        data: { nextAttemptAt: deferUntil },
      })
      recordOutboxLowDeferred()
      throw new Error(
        `LOW op ${opId} deferred due to high congestion (${snap.congestionLevel})`
      )
    }
  } catch (err) {
    // If the error is our deferral throw, rethrow; otherwise log and proceed
    // (a broken fee oracle must not block dispatching — fail open here).
    if (
      err instanceof Error &&
      err.message.includes('deferred due to high congestion')
    )
      throw err
    logger.warn('[Outbox] Defer check failed, proceeding to dispatch', {
      opId: op.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Decide which signer account will submit, then atomically claim the op.
  const signerPublicKey = await resolveSignerPublicKey(op.payload, op.userId)
  const claimed = await claimOp(opId, signerPublicKey)
  if (!claimed) {
    // Lost the claim race. Re-read: if the winner already confirmed it,
    // return that result; otherwise surface the conflict as an error.
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
  // Errors are only logged: the op stays durable, so the sweep can retry.
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
  updateOutboxStuckSubmitted(stuck.length) // gauge for monitoring/alerting

  for (const op of stuck) {
    // Step 1: if we have a txHash, ask the chain what actually happened
    // before deciding to resubmit (avoids double-submitting a tx that landed).
    if (op.txHash) {
      let chainStatus: 'success' | 'failed' | 'not_found'
      try {
        chainStatus = await getTransactionStatus(op.txHash)
      } catch (err) {
        // RPC unavailable: leave the op alone and try again next sweep.
        logger.warn('[Outbox] Could not reconcile submitted transaction hash', {
          opId: op.id,
          txHash: op.txHash,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      // It landed after all: close the op out as confirmed.
      if (chainStatus === 'success') {
        await markConfirmed(op.id, op.txHash)
        await mirrorLinkedTransaction(op.payload, {
          txHash: op.txHash,
          status: 'CONFIRMED',
        })
        recordOutboxOp(op.kind, op.priority, 'confirmed')
        continue
      }

      // It landed but failed on-chain: terminal, no retry.
      if (chainStatus === 'failed') {
        await markFailedTerminal(
          op.id,
          op.txHash,
          'Stellar RPC confirmed the submitted transaction failed'
        )
        await mirrorLinkedTransaction(op.payload, {
          txHash: op.txHash,
          status: 'FAILED',
        })
        recordOutboxOp(op.kind, op.priority, 'failed')
        await onTerminalFailure(op, 'Submitted Stellar transaction failed')
        continue
      }

      if (chainStatus === 'not_found') {
        // The network no longer knows this hash (expired from the RPC
        // window or never propagated). Fee-bumping the same envelope
        // cannot confirm it, so clear the stale hash and send the op
        // back through the retry pipeline for a fresh submission —
        // subject to the same fee-bump cap as any other retry.
        logger.warn(
          '[Outbox] Submitted hash unknown to network — clearing for resubmission',
          {
            opId: op.id,
            kind: op.kind,
            txHash: op.txHash,
            attempts: op.attempts,
          }
        )
        await clearStaleSubmittedTxHash(op.id)
        op.txHash = null
      }
      // 'not_found' falls through to the escalation logic below.
    }

    // Step 2: out of fee-bump attempts. Passing attempts=maxAttempts here
    // forces markFailedOrRetry down its terminal branch, so this always
    // ends in FAILED (the `terminal` flag is effectively always true).
    if (op.attempts >= config.outbox.feeBumpMaxAttempts) {
      const { terminal } = await markFailedOrRetry(
        { id: op.id, attempts: config.outbox.maxAttempts },
        `Unconfirmed after ${config.outbox.feeBumpMaxAttempts} fee-bump attempts (submittedAt=${op.submittedAt?.toISOString()})`
      )
      recordOutboxOp(op.kind, op.priority, terminal ? 'failed' : 'retry')
      if (terminal) await onTerminalFailure(op, 'Fee-bump cap exceeded')
      continue
    }

    // Step 3: still within the fee-bump budget — requeue as PENDING. The
    // next claim bumps `attempts`, which raises the fee on resubmission.
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
  // First clean up anything stuck, so requeued ops can be picked up below.
  await reconcileStuckSubmitted()

  // Refresh the queue-depth gauges.
  const stats = await getQueueStats()
  updateOutboxQueueDepth(stats)

  // Fetch up to batchSize eligible ops, then order by priority.
  const claimable = sortForDispatch(
    await findClaimableOps(config.outbox.batchSize)
  )

  for (const op of claimable) {
    // Skip (but leave PENDING) ops belonging to frozen users.
    if (await isUserHalted(op.userId)) {
      logger.info('[Outbox] Skipping op for frozen user', {
        opId: op.id,
        userId: op.userId,
      })
      continue
    }

    // LOW deferral during high/severe congestion (bounded)
    // Same rule as dispatchOne, but here we `continue` instead of throwing.
    try {
      const snap = getFeeSnapshot()
      if (shouldDeferLowOp(op, snap.congestionLevel)) {
        const deferUntil = new Date(Date.now() + config.outbox.lowDeferMs)
        await db.outboxOp.update({
          where: { id: op.id },
          data: { nextAttemptAt: deferUntil },
        })
        recordOutboxLowDeferred()
        logger.info('[Outbox] LOW op deferred due to high congestion', {
          opId: op.id,
          congestion: snap.congestionLevel,
          deferUntil: deferUntil.toISOString(),
        })
        continue
      }
    } catch (err) {
      // Fail open: a fee-oracle problem shouldn't stall the whole sweep.
      logger.warn('[Outbox] Defer check failed, proceeding to dispatch', {
        opId: op.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Work out which signer would submit; skip this op if that fails so one
    // bad op can't abort the rest of the batch.
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

    // Respect global and per-signer in-flight limits before claiming.
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

// Handle to the running interval, kept at module scope (e.g. for shutdown).
let dispatcherHandle: NodeJS.Timeout | null = null

/**
 * Start the background dispatcher: run one sweep immediately, then repeat
 * every dispatchIntervalMs. Sweep errors are logged and never propagate, so
 * a single failed sweep can't kill the timer. Returns the interval handle so
 * callers can clear it on shutdown.
 *
 * Note: sweeps are not guarded against overlap — if one runs longer than the
 * interval, the next starts anyway. This is safe because claimOp is atomic.
 */
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
