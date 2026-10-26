/**
 * Scheduled Fiat Purchases (Card/Bank-Funded DCA) with Idempotent Retry (#361).
 *
 * Drives the existing multi-provider fiat on-ramp flow on a cadence, chains the
 * confirmed crypto settlement into a strategy deposit when `autoDeposit = true`,
 * and handles card/bank failure modes (declines, 3-DS challenges, quote-lock
 * expiry, provider circuit-breakers, and retries) idempotently per occurrence
 * `(planId, scheduledFor)`.
 */
import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import { executeDeposit } from '../controllers/transaction-controller'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { alertingService } from '../services/alerting'
import { addCadence } from '../utils/cadence'
import { auditPayloadHashFor } from '../audit/chain'
import { getBestExecutionQuote, createFiatOrder } from '../fiat/service'
import { NoHealthyProvidersError, FiatOrderError } from '../fiat/types'
import type { FiatPurchaseRetryPolicy } from '../validators/fiat-validators'

type Db = typeof db

/** Lease duration for an `executing` claim before a crash recovery may reclaim it. */
export const FIAT_PURCHASE_EXECUTING_LEASE_MS = Number(
  process.env.FIAT_PURCHASE_EXECUTING_LEASE_MS || 10 * 60 * 1000
)

/** How long a 3-DS / user-action-required challenge waits before failing that attempt. */
export const ACTION_TIMEOUT_MS = Number(
  process.env.FIAT_PURCHASE_ACTION_TIMEOUT_MS || 30 * 60 * 1000
)

/** How long a run may sit in `awaiting_settlement` before being force-failed and alerted. */
export const RUN_STUCK_TIMEOUT_MS = Number(
  process.env.FIAT_PURCHASE_RUN_STUCK_TIMEOUT_MS || 24 * 60 * 60 * 1000
)

/** Default interval between scheduled fiat purchase job ticks. */
export const FIAT_PURCHASES_INTERVAL_MS = Number(
  process.env.FIAT_PURCHASES_INTERVAL_MS || 60_000
)

/** Maximum consecutive terminal run failures before auto-pausing a plan. */
export const MAX_CONSECUTIVE_PLAN_FAILURES = 3

const HARD_DECLINE_CODES = new Set([
  'card_declined_hard',
  'payment_instrument_revoked',
  'stolen_card',
  'lost_card',
  'account_closed',
  'do_not_honor',
  'invalid_payment_method',
])

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'completed_deposit_pending',
  'skipped_rate',
  'failed',
])

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return Boolean(status && TERMINAL_RUN_STATUSES.has(status))
}

export function isHardDeclineReason(reason: string | null | undefined): boolean {
  if (!reason) return false
  const normalized = reason.trim().toLowerCase()
  if (HARD_DECLINE_CODES.has(normalized)) return true
  for (const code of HARD_DECLINE_CODES) {
    if (normalized.includes(code)) return true
  }
  return false
}

export function parseRetryPolicy(raw: unknown): FiatPurchaseRetryPolicy {
  const obj =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const maxAttempts =
    typeof obj.maxAttempts === 'number' && obj.maxAttempts >= 1
      ? Math.min(10, Math.floor(obj.maxAttempts))
      : 3
  const backoffMinutes =
    typeof obj.backoffMinutes === 'number' && obj.backoffMinutes >= 1
      ? Math.min(10080, Math.floor(obj.backoffMinutes))
      : 15
  return { maxAttempts, backoffMinutes }
}

export function isExecutingClaimStale(
  plan: { lastRunStatus: string | null; lastRunAt: Date | null },
  now: Date = new Date(),
  leaseMs: number = FIAT_PURCHASE_EXECUTING_LEASE_MS
): boolean {
  if (plan.lastRunStatus !== 'executing') return false
  if (!plan.lastRunAt) return true
  return now.getTime() - new Date(plan.lastRunAt).getTime() >= leaseMs
}

/**
 * Evaluate whether a live on-ramp quote violates the plan's `maxSlippagePct`
 * relative to `baselineRate`.
 *
 * For ON_RAMP, `rate` is `cryptoAmount / fiatAmount` (crypto received per unit
 * of fiat). A lower live rate means the user receives less crypto than
 * baseline; if `(baselineRate - liveRate) / baselineRate > maxSlippagePct`,
 * the run must be skipped (`skipped_rate`).
 */
export function evaluateQuoteSlippage(params: {
  baselineRate: number | null
  liveRate: number
  maxSlippagePct: number | null
}): {
  withinSlippage: boolean
  slippagePct: number
  effectiveBaselineRate: number
} {
  const effectiveBaselineRate =
    params.baselineRate != null && params.baselineRate > 0
      ? params.baselineRate
      : params.liveRate

  if (
    params.maxSlippagePct == null ||
    params.baselineRate == null ||
    params.baselineRate <= 0
  ) {
    return {
      withinSlippage: true,
      slippagePct: 0,
      effectiveBaselineRate,
    }
  }

  const slippagePct =
    (params.baselineRate - params.liveRate) / params.baselineRate
  const withinSlippage = slippagePct <= params.maxSlippagePct + 1e-9

  return {
    withinSlippage,
    slippagePct,
    effectiveBaselineRate,
  }
}

export function calculateNextFiatPurchaseRun(
  cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY',
  from: Date = new Date()
): Date {
  return addCadence(cadence, from)
}

export async function recordPlanAuditEntry(
  database: Db,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await (database as any).auditPayloadHash?.create({
      data: {
        tableName: 'fiat_purchase_plans',
        kind,
        payloadHash: auditPayloadHashFor(payload),
      },
    })
  } catch (err) {
    logger.warn('[FiatPurchase] Failed to write audit payload hash', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Check if a user is inactive or under an active compliance freeze (#321).
 */
export async function isUserComplianceFrozen(
  userId: string,
  database: Db = db
): Promise<{ frozen: boolean; reason?: string }> {
  const user = await (database as any).user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  })
  if (!user || !user.isActive) {
    return { frozen: true, reason: 'user_inactive' }
  }

  const activeCase = await (database as any).complianceCase?.findFirst({
    where: {
      userId,
      status: {
        in: ['OPEN', 'TRIAGE', 'INVESTIGATING', 'ESCALATED', 'PENDING_SAR'],
      },
    },
    select: { id: true, status: true },
  })

  if (activeCase) {
    return { frozen: true, reason: 'compliance_freeze' }
  }

  return { frozen: false }
}

/**
 * Atomically claim a due FiatPurchasePlan for execution.
 * Uses conditional `updateMany` so concurrent workers cannot double-claim the
 * same occurrence. Also skips plans currently in `awaiting_settlement`,
 * `action_required`, or `retrying` (handled by `sweepInFlightPlanRuns`).
 */
export async function claimDueFiatPurchasePlan(
  planId: string,
  now: Date = new Date(),
  database: Db = db
): Promise<any | null> {
  const plan = await (database as any).fiatPurchasePlan.findUnique({
    where: { id: planId },
  })

  if (!plan || plan.status !== 'ACTIVE' || new Date(plan.nextRunAt) > now) {
    return null
  }

  if (
    plan.lastRunStatus === 'awaiting_settlement' ||
    plan.lastRunStatus === 'action_required' ||
    plan.lastRunStatus === 'retrying'
  ) {
    return null
  }

  const staleExecuting = isExecutingClaimStale(plan, now)
  if (plan.lastRunStatus === 'executing' && !staleExecuting) {
    return null
  }

  const updated = await (database as any).fiatPurchasePlan.updateMany({
    where: {
      id: planId,
      status: 'ACTIVE',
      nextRunAt: plan.nextRunAt,
      ...(staleExecuting
        ? { lastRunStatus: 'executing' }
        : {
            OR: [
              { lastRunStatus: null },
              {
                lastRunStatus: {
                  notIn: [
                    'executing',
                    'awaiting_settlement',
                    'action_required',
                    'retrying',
                  ],
                },
              },
            ],
          }),
    },
    data: {
      lastRunAt: now,
      lastRunStatus: 'executing',
    },
  })

  if (updated.count === 0) {
    return null
  }

  return (database as any).fiatPurchasePlan.findUnique({
    where: { id: planId },
  })
}

async function resolveUserWalletAddress(
  userId: string,
  database: Db = db
): Promise<string | null> {
  const custodial = await (database as any).custodialWallet?.findUnique({
    where: { userId },
    select: { publicKey: true },
  })
  if (custodial?.publicKey) return custodial.publicKey

  const user = await (database as any).user.findUnique({
    where: { id: userId },
    select: { walletAddress: true },
  })
  return user?.walletAddress ?? null
}

/**
 * Execute a single claimed FiatPurchasePlan or retry occurrence.
 */
export async function executeFiatPurchasePlan(
  plan: any,
  now: Date = new Date(),
  database: Db = db
): Promise<{ status: string; runId?: string; orderId?: string }> {
  const scheduledFor = new Date(plan.nextRunAt)
  const retryPolicy = parseRetryPolicy(plan.retryPolicy)
  const fiatAmount = Number(plan.fiatAmount)

  // 1. Compliance freeze check (#321)
  const freezeCheck = await isUserComplianceFrozen(plan.userId, database)
  if (freezeCheck.frozen) {
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        status: 'PAUSED',
        autoPauseReason: freezeCheck.reason ?? 'compliance_freeze',
        lastRunStatus: 'paused_compliance_freeze',
      },
    })
    await recordPlanAuditEntry(database, 'PLAN_PAUSED_COMPLIANCE', {
      planId: plan.id,
      userId: plan.userId,
      reason: freezeCheck.reason,
      at: now.toISOString(),
    })
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['fiat_purchase.failed'],
      'fiat_purchase.failed',
      {
        planId: plan.id,
        userId: plan.userId,
        reason: freezeCheck.reason ?? 'compliance_freeze',
        autoPaused: true,
      }
    ).catch(() => {})
    return { status: 'paused_compliance_freeze' }
  }

  // 2. Per-occurrence idempotency: lookup or create (planId, scheduledFor)
  let run = await (database as any).fiatPurchasePlanRun.findUnique({
    where: {
      planId_scheduledFor: {
        planId: plan.id,
        scheduledFor,
      },
    },
  })

  if (run && isTerminalRunStatus(run.status)) {
    // Occurrence already reached a terminal state; advance nextRunAt idempotently.
    const nextRunAt = addCadence(plan.cadence, scheduledFor)
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: run.status,
        nextRunAt,
      },
    })
    return { status: run.status, runId: run.id }
  }

  if (!run) {
    run = await (database as any).fiatPurchasePlanRun.create({
      data: {
        planId: plan.id,
        userId: plan.userId,
        scheduledFor,
        attemptCount: 1,
        status: 'executing',
        fiatAmount: plan.fiatAmount,
        fiatCurrency: plan.fiatCurrency,
        assetSymbol: plan.assetSymbol,
        baselineRate: plan.baselineRate ?? null,
        fiatOrderIds: [],
      },
    })
  }

  return submitOnRampAttemptForRun(plan, run, retryPolicy, fiatAmount, now, database)
}

async function submitOnRampAttemptForRun(
  plan: any,
  run: any,
  retryPolicy: FiatPurchaseRetryPolicy,
  fiatAmount: number,
  now: Date,
  database: Db
): Promise<{ status: string; runId: string; orderId?: string }> {
  const scheduledFor = new Date(run.scheduledFor)
  const walletAddress = await resolveUserWalletAddress(plan.userId, database)
  if (!walletAddress) {
    const nextRunAt = addCadence(plan.cadence, scheduledFor)
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        failureReason: 'no_wallet_address',
        completedAt: now,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'failed',
        nextRunAt,
        consecutiveFailures: (plan.consecutiveFailures ?? 0) + 1,
      },
    })
    return { status: 'failed', runId: run.id }
  }

  // 3. Get live quote through the registry
  let quoteResult
  try {
    quoteResult = await getBestExecutionQuote(
      {
        direction: 'ON_RAMP',
        fiatAmount,
        fiatCurrency: plan.fiatCurrency,
        assetSymbol: plan.assetSymbol,
      },
      { userId: plan.userId },
      database
    )
  } catch (err) {
    if (err instanceof NoHealthyProvidersError) {
      const nextRetryAt = new Date(
        now.getTime() + retryPolicy.backoffMinutes * 60_000
      )
      await (database as any).fiatPurchasePlanRun.update({
        where: { id: run.id },
        data: {
          status: 'deferred_unhealthy',
          nextRetryAt,
          failureReason: 'all_providers_unhealthy',
        },
      })
      await (database as any).fiatPurchasePlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'deferred_unhealthy',
        },
      })
      await alertingService
        .emit(
          {
            title: 'Scheduled fiat purchase deferred — all providers unhealthy',
            description: `Plan ${plan.id} occurrence ${scheduledFor.toISOString()} deferred because no healthy fiat providers are available.`,
            severity: 'warning',
            component: 'fiat-purchases',
            metadata: {
              planId: plan.id,
              runId: run.id,
              failures: err.failures,
            },
          },
          `fiat-purchase:unhealthy:${plan.id}`
        )
        .catch(() => {})
      return { status: 'deferred_unhealthy', runId: run.id }
    }
    throw err
  }

  const bestQuote = quoteResult.best
  if (!bestQuote) {
    const nextRetryAt = new Date(
      now.getTime() + retryPolicy.backoffMinutes * 60_000
    )
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'deferred_unhealthy',
        nextRetryAt,
        failureReason: 'no_quotes_available',
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: { lastRunStatus: 'deferred_unhealthy' },
    })
    return { status: 'deferred_unhealthy', runId: run.id }
  }

  const liveRate =
    bestQuote.rate != null && bestQuote.rate > 0
      ? Number(bestQuote.rate)
      : bestQuote.cryptoAmount / fiatAmount
  const storedBaseline =
    plan.baselineRate != null ? Number(plan.baselineRate) : null
  const maxSlippagePct =
    plan.maxSlippagePct != null ? Number(plan.maxSlippagePct) : null

  const slippage = evaluateQuoteSlippage({
    baselineRate: storedBaseline,
    liveRate,
    maxSlippagePct,
  })

  if (!slippage.withinSlippage) {
    const nextRunAt = addCadence(plan.cadence, scheduledFor)
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'skipped_rate',
        baselineRate: slippage.effectiveBaselineRate,
        liveQuoteRate: liveRate,
        quotedCryptoAmount: bestQuote.cryptoAmount,
        failureReason: `Live quote rate (${liveRate.toFixed(6)}) worse than baseline (${slippage.effectiveBaselineRate.toFixed(6)}) by ${(slippage.slippagePct * 100).toFixed(2)}% > maxSlippagePct (${((maxSlippagePct ?? 0) * 100).toFixed(2)}%)`,
        completedAt: now,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'skipped_rate',
        nextRunAt,
      },
    })
    await recordPlanAuditEntry(database, 'RUN_SKIPPED_RATE', {
      planId: plan.id,
      runId: run.id,
      userId: plan.userId,
      baselineRate: slippage.effectiveBaselineRate,
      liveQuoteRate: liveRate,
      slippagePct: slippage.slippagePct,
      maxSlippagePct,
      at: now.toISOString(),
    })
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['fiat_purchase.skipped'],
      'fiat_purchase.skipped',
      {
        planId: plan.id,
        runId: run.id,
        userId: plan.userId,
        reason: 'skipped_rate',
        baselineRate: slippage.effectiveBaselineRate,
        liveQuoteRate: liveRate,
        slippagePct: slippage.slippagePct,
        maxSlippagePct,
        nextRunAt: nextRunAt.toISOString(),
      }
    ).catch(() => {})
    return { status: 'skipped_rate', runId: run.id }
  }

  // Persist initial baselineRate on the plan if not yet set
  if (storedBaseline == null) {
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: { baselineRate: liveRate },
    })
  }

  // 4. Create the on-ramp order (with single re-quote on quote_expired)
  let order: any
  let activeQuote = bestQuote
  let activeLiveRate = liveRate
  try {
    order = await createFiatOrder(
      {
        userId: plan.userId,
        direction: 'ON_RAMP',
        fiatAmount,
        fiatCurrency: plan.fiatCurrency,
        assetSymbol: plan.assetSymbol,
        provider: activeQuote.provider,
        quoteId: activeQuote.quoteId,
      },
      { walletAddress },
      database
    )
  } catch (err) {
    if (err instanceof FiatOrderError && err.code === 'quote_expired') {
      // Quote lock expired mid-run: re-quote once; if still within slippage, proceed; else skipped_rate
      const refreshed = await getBestExecutionQuote(
        {
          direction: 'ON_RAMP',
          fiatAmount,
          fiatCurrency: plan.fiatCurrency,
          assetSymbol: plan.assetSymbol,
        },
        { userId: plan.userId },
        database
      )
      if (!refreshed.best) {
        throw err
      }
      activeQuote = refreshed.best
      activeLiveRate =
        activeQuote.rate != null && activeQuote.rate > 0
          ? Number(activeQuote.rate)
          : activeQuote.cryptoAmount / fiatAmount
      const recheck = evaluateQuoteSlippage({
        baselineRate: slippage.effectiveBaselineRate,
        liveRate: activeLiveRate,
        maxSlippagePct,
      })
      if (!recheck.withinSlippage) {
        const nextRunAt = addCadence(plan.cadence, scheduledFor)
        await (database as any).fiatPurchasePlanRun.update({
          where: { id: run.id },
          data: {
            status: 'skipped_rate',
            baselineRate: recheck.effectiveBaselineRate,
            liveQuoteRate: activeLiveRate,
            quotedCryptoAmount: activeQuote.cryptoAmount,
            failureReason: 'Slippage exceeded after quote lock refresh',
            completedAt: now,
          },
        })
        await (database as any).fiatPurchasePlan.update({
          where: { id: plan.id },
          data: {
            lastRunStatus: 'skipped_rate',
            nextRunAt,
          },
        })
        publishUserEvent(
          plan.userId,
          EVENT_TYPE_TOPIC['fiat_purchase.skipped'],
          'fiat_purchase.skipped',
          {
            planId: plan.id,
            runId: run.id,
            userId: plan.userId,
            reason: 'skipped_rate',
            baselineRate: recheck.effectiveBaselineRate,
            liveQuoteRate: activeLiveRate,
            slippagePct: recheck.slippagePct,
            maxSlippagePct,
            nextRunAt: nextRunAt.toISOString(),
          }
        ).catch(() => {})
        return { status: 'skipped_rate', runId: run.id }
      }
      order = await createFiatOrder(
        {
          userId: plan.userId,
          direction: 'ON_RAMP',
          fiatAmount,
          fiatCurrency: plan.fiatCurrency,
          assetSymbol: plan.assetSymbol,
          provider: activeQuote.provider,
          quoteId: activeQuote.quoteId,
        },
        { walletAddress },
        database
      )
    } else {
      // Provider order creation error — route through card/bank retry handler
      const reason =
        err instanceof Error ? err.message : 'provider_order_create_failed'
      return handleAttemptFailure(
        plan,
        run,
        reason,
        retryPolicy,
        now,
        database
      )
    }
  }

  const updatedOrderIds = Array.from(
    new Set([...(run.fiatOrderIds ?? []), order.id])
  )

  // Check if provider immediately reported FAILED at creation
  if (order.status === 'FAILED' || order.status === 'REFUNDED') {
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        fiatOrderId: order.id,
        fiatOrderIds: updatedOrderIds,
        baselineRate: slippage.effectiveBaselineRate,
        liveQuoteRate: activeLiveRate,
        quotedCryptoAmount: activeQuote.cryptoAmount,
      },
    })
    return handleAttemptFailure(
      plan,
      { ...run, fiatOrderId: order.id, fiatOrderIds: updatedOrderIds },
      order.failureReason ?? 'order_failed_on_create',
      retryPolicy,
      now,
      database
    )
  }

  // Check if 3-DS / user-action-required is surfaced by the provider
  const actionUrl = order.kycUrl ?? (order as any).actionRequiredUrl ?? null
  if (actionUrl) {
    const actionExpiresAt = new Date(now.getTime() + ACTION_TIMEOUT_MS)
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'action_required',
        fiatOrderId: order.id,
        fiatOrderIds: updatedOrderIds,
        baselineRate: slippage.effectiveBaselineRate,
        liveQuoteRate: activeLiveRate,
        quotedCryptoAmount: activeQuote.cryptoAmount,
        actionRequiredUrl: actionUrl,
        actionExpiresAt,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'action_required',
        lastRunFiatOrderId: order.id,
      },
    })
    await recordPlanAuditEntry(database, 'RUN_ACTION_REQUIRED', {
      planId: plan.id,
      runId: run.id,
      orderId: order.id,
      actionRequiredUrl: actionUrl,
      actionExpiresAt: actionExpiresAt.toISOString(),
    })
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['fiat_purchase.action_required'],
      'fiat_purchase.action_required',
      {
        planId: plan.id,
        runId: run.id,
        orderId: order.id,
        userId: plan.userId,
        actionRequiredUrl: actionUrl,
        actionExpiresAt: actionExpiresAt.toISOString(),
      }
    ).catch(() => {})
    return { status: 'action_required', runId: run.id, orderId: order.id }
  }

  // Normal async on-ramp flow: awaiting provider + on-chain confirmation
  await (database as any).fiatPurchasePlanRun.update({
    where: { id: run.id },
    data: {
      status: 'awaiting_settlement',
      fiatOrderId: order.id,
      fiatOrderIds: updatedOrderIds,
      baselineRate: slippage.effectiveBaselineRate,
      liveQuoteRate: activeLiveRate,
      quotedCryptoAmount: activeQuote.cryptoAmount,
      nextRetryAt: null,
    },
  })
  await (database as any).fiatPurchasePlan.update({
    where: { id: plan.id },
    data: {
      lastRunStatus: 'awaiting_settlement',
      lastRunFiatOrderId: order.id,
    },
  })
  await recordPlanAuditEntry(database, 'RUN_AWAITING_SETTLEMENT', {
    planId: plan.id,
    runId: run.id,
    orderId: order.id,
    userId: plan.userId,
    fiatAmount,
    fiatCurrency: plan.fiatCurrency,
    assetSymbol: plan.assetSymbol,
    liveQuoteRate: activeLiveRate,
    quotedCryptoAmount: activeQuote.cryptoAmount,
    at: now.toISOString(),
  })

  return { status: 'awaiting_settlement', runId: run.id, orderId: order.id }
}

/**
 * Handle an on-ramp attempt failure according to `retryPolicy` and hard-decline
 * auto-pause rules.
 */
async function handleAttemptFailure(
  plan: any,
  run: any,
  failureReason: string,
  retryPolicy: FiatPurchaseRetryPolicy,
  now: Date,
  database: Db
): Promise<{ status: string; runId: string }> {
  const scheduledFor = new Date(run.scheduledFor)
  const hardDecline = isHardDeclineReason(failureReason)
  const isInsufficientFunds = failureReason
    .toLowerCase()
    .includes('insufficient_funds')
  const attemptsExhausted = run.attemptCount >= retryPolicy.maxAttempts

  if (hardDecline || (isInsufficientFunds && attemptsExhausted)) {
    const nextRunAt = addCadence(plan.cadence, scheduledFor)
    const pauseReason = hardDecline
      ? `Hard decline: ${failureReason}`
      : `Insufficient funds after ${run.attemptCount} attempts`

    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        failureReason,
        completedAt: now,
        nextRetryAt: null,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        status: 'PAUSED',
        autoPauseReason: pauseReason,
        lastRunStatus: 'failed',
        nextRunAt,
        consecutiveFailures: (plan.consecutiveFailures ?? 0) + 1,
      },
    })
    await recordPlanAuditEntry(database, 'PLAN_AUTO_PAUSED_DECLINE', {
      planId: plan.id,
      runId: run.id,
      userId: plan.userId,
      failureReason,
      pauseReason,
      attempts: run.attemptCount,
      at: now.toISOString(),
    })
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['fiat_purchase.failed'],
      'fiat_purchase.failed',
      {
        planId: plan.id,
        runId: run.id,
        userId: plan.userId,
        reason: failureReason,
        autoPaused: true,
        autoPauseReason: pauseReason,
      }
    ).catch(() => {})
    return { status: 'failed', runId: run.id }
  }

  if (!attemptsExhausted) {
    const backoffMs =
      retryPolicy.backoffMinutes *
      60_000 *
      Math.pow(2, Math.max(0, run.attemptCount - 1))
    const nextRetryAt = new Date(now.getTime() + backoffMs)

    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'retrying',
        failureReason,
        nextRetryAt,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'retrying',
      },
    })
    return { status: 'retrying', runId: run.id }
  }

  // Soft failure with all retries exhausted for this occurrence
  const nextRunAt = addCadence(plan.cadence, scheduledFor)
  const newConsecutive = (plan.consecutiveFailures ?? 0) + 1
  const shouldPause = newConsecutive >= MAX_CONSECUTIVE_PLAN_FAILURES

  await (database as any).fiatPurchasePlanRun.update({
    where: { id: run.id },
    data: {
      status: 'failed',
      failureReason,
      completedAt: now,
      nextRetryAt: null,
    },
  })
  await (database as any).fiatPurchasePlan.update({
    where: { id: plan.id },
    data: {
      ...(shouldPause
        ? {
            status: 'PAUSED',
            autoPauseReason: `Auto-paused after ${newConsecutive} consecutive failed runs`,
          }
        : {}),
      lastRunStatus: 'failed',
      nextRunAt,
      consecutiveFailures: newConsecutive,
    },
  })
  await recordPlanAuditEntry(database, 'RUN_FAILED', {
    planId: plan.id,
    runId: run.id,
    userId: plan.userId,
    failureReason,
    attempts: run.attemptCount,
    autoPaused: shouldPause,
    at: now.toISOString(),
  })
  publishUserEvent(
    plan.userId,
    EVENT_TYPE_TOPIC['fiat_purchase.failed'],
    'fiat_purchase.failed',
    {
      planId: plan.id,
      runId: run.id,
      userId: plan.userId,
      reason: failureReason,
      autoPaused: shouldPause,
    }
  ).catch(() => {})
  return { status: 'failed', runId: run.id }
}

/**
 * Settlement hook: invoked when a `FiatOrder` reaches `SETTLED` (confirmed
 * on-chain). If the order belongs to a `FiatPurchasePlanRun`, chains the
 * settled crypto into `executeDeposit` when `plan.autoDeposit = true`, advances
 * `plan.nextRunAt` on terminal completion, and emits `fiat_purchase.completed`.
 *
 * Keyed and guarded by conditional update so duplicate `SETTLED` deliveries or
 * concurrent reconciliation sweeps never double-deposit.
 */
export async function handleFiatOrderSettledForPlan(
  fiatOrderId: string,
  database: Db = db
): Promise<{
  handled: boolean
  status?: string
  runId?: string
  depositTxId?: string | null
}> {
  const run = await (database as any).fiatPurchasePlanRun?.findFirst({
    where: {
      OR: [
        { fiatOrderId },
        { fiatOrderIds: { has: fiatOrderId } },
      ],
    },
    include: { plan: true },
  })

  if (!run || !run.plan) {
    return { handled: false }
  }

  if (
    run.status === 'completed' ||
    run.status === 'completed_deposit_pending' ||
    run.status === 'settling'
  ) {
    return { handled: true, status: run.status, runId: run.id }
  }

  // Atomically claim the run for settlement processing so concurrent calls
  // cannot both invoke executeDeposit.
  const claimed = await (database as any).fiatPurchasePlanRun.updateMany({
    where: {
      id: run.id,
      status: {
        notIn: ['completed', 'completed_deposit_pending', 'settling'],
      },
    },
    data: {
      status: 'settling',
    },
  })

  if (claimed.count === 0) {
    return { handled: true, status: 'already_claimed', runId: run.id }
  }

  const order = await (database as any).fiatOrder.findUnique({
    where: { id: fiatOrderId },
  })
  const settledCryptoAmount = Number(
    order?.settledCryptoAmount ??
      order?.cryptoAmount ??
      run.quotedCryptoAmount ??
      0
  )

  const now = new Date()
  const plan = run.plan
  const nextRunAt = addCadence(plan.cadence, new Date(run.scheduledFor))

  if (!plan.autoDeposit) {
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        settledCryptoAmount,
        completedAt: now,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'completed',
        consecutiveFailures: 0,
        nextRunAt,
      },
    })
    await recordPlanAuditEntry(database, 'RUN_COMPLETED', {
      planId: plan.id,
      runId: run.id,
      orderId: fiatOrderId,
      userId: plan.userId,
      settledCryptoAmount,
      autoDeposit: false,
      at: now.toISOString(),
    })
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['fiat_purchase.completed'],
      'fiat_purchase.completed',
      {
        planId: plan.id,
        runId: run.id,
        orderId: fiatOrderId,
        userId: plan.userId,
        settledCryptoAmount,
        assetSymbol: plan.assetSymbol,
        autoDeposit: false,
        nextRunAt: nextRunAt.toISOString(),
      }
    ).catch(() => {})
    return { handled: true, status: 'completed', runId: run.id }
  }

  // autoDeposit = true: chain settled crypto into user's effective strategy
  const walletAddress = await resolveUserWalletAddress(plan.userId, database)
  if (!walletAddress || settledCryptoAmount <= 0) {
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'completed_deposit_pending',
        settledCryptoAmount,
        failureReason: !walletAddress
          ? 'missing_wallet_for_auto_deposit'
          : 'zero_settled_amount',
        completedAt: now,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'completed_deposit_pending',
        nextRunAt,
      },
    })
    return {
      handled: true,
      status: 'completed_deposit_pending',
      runId: run.id,
    }
  }

  try {
    const depositResult = await executeDeposit({
      userId: plan.userId,
      walletAddress,
      amount: settledCryptoAmount,
      assetSymbol: plan.assetSymbol,
      memo: `fiat-purchase:${plan.id}:${run.id}`,
    })

    if (
      depositResult.status === 'CONFIRMED' ||
      depositResult.status === 'PENDING_APPROVAL'
    ) {
      const depositTxId = depositResult.transaction?.id ?? null
      const depositTxHash = depositResult.transaction?.txHash ?? null

      await (database as any).fiatPurchasePlanRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          settledCryptoAmount,
          depositTxId,
          depositTxHash,
          completedAt: now,
        },
      })
      await (database as any).fiatPurchasePlan.update({
        where: { id: plan.id },
        data: {
          lastRunStatus: 'completed',
          consecutiveFailures: 0,
          nextRunAt,
        },
      })
      await recordPlanAuditEntry(database, 'RUN_COMPLETED_WITH_DEPOSIT', {
        planId: plan.id,
        runId: run.id,
        orderId: fiatOrderId,
        userId: plan.userId,
        settledCryptoAmount,
        depositTxId,
        depositTxHash,
        at: now.toISOString(),
      })
      publishUserEvent(
        plan.userId,
        EVENT_TYPE_TOPIC['fiat_purchase.completed'],
        'fiat_purchase.completed',
        {
          planId: plan.id,
          runId: run.id,
          orderId: fiatOrderId,
          userId: plan.userId,
          settledCryptoAmount,
          assetSymbol: plan.assetSymbol,
          autoDeposit: true,
          depositTxId,
          depositTxHash,
          nextRunAt: nextRunAt.toISOString(),
        }
      ).catch(() => {})

      return {
        handled: true,
        status: 'completed',
        runId: run.id,
        depositTxId,
      }
    }

    // Deposit returned FAILED — crypto is safe in user's wallet; mark completed_deposit_pending
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'completed_deposit_pending',
        settledCryptoAmount,
        failureReason: 'auto_deposit_failed',
        completedAt: now,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'completed_deposit_pending',
        nextRunAt,
      },
    })
    await recordPlanAuditEntry(database, 'RUN_COMPLETED_DEPOSIT_PENDING', {
      planId: plan.id,
      runId: run.id,
      orderId: fiatOrderId,
      userId: plan.userId,
      settledCryptoAmount,
      reason: 'auto_deposit_failed',
      at: now.toISOString(),
    })
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['fiat_purchase.completed'],
      'fiat_purchase.completed',
      {
        planId: plan.id,
        runId: run.id,
        orderId: fiatOrderId,
        userId: plan.userId,
        settledCryptoAmount,
        assetSymbol: plan.assetSymbol,
        autoDeposit: true,
        depositPending: true,
        nextRunAt: nextRunAt.toISOString(),
      }
    ).catch(() => {})

    return {
      handled: true,
      status: 'completed_deposit_pending',
      runId: run.id,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(
      '[FiatPurchase] Auto-deposit failed after fiat settlement; funds remain safe in wallet',
      {
        planId: plan.id,
        runId: run.id,
        orderId: fiatOrderId,
        error: message,
      }
    )
    await (database as any).fiatPurchasePlanRun.update({
      where: { id: run.id },
      data: {
        status: 'completed_deposit_pending',
        settledCryptoAmount,
        failureReason: `auto_deposit_error: ${message}`,
        completedAt: now,
      },
    })
    await (database as any).fiatPurchasePlan.update({
      where: { id: plan.id },
      data: {
        lastRunStatus: 'completed_deposit_pending',
        nextRunAt,
      },
    })
    await recordPlanAuditEntry(database, 'RUN_COMPLETED_DEPOSIT_PENDING', {
      planId: plan.id,
      runId: run.id,
      orderId: fiatOrderId,
      userId: plan.userId,
      settledCryptoAmount,
      reason: message,
      at: now.toISOString(),
    })
    publishUserEvent(
      plan.userId,
      EVENT_TYPE_TOPIC['fiat_purchase.completed'],
      'fiat_purchase.completed',
      {
        planId: plan.id,
        runId: run.id,
        orderId: fiatOrderId,
        userId: plan.userId,
        settledCryptoAmount,
        assetSymbol: plan.assetSymbol,
        autoDeposit: true,
        depositPending: true,
        nextRunAt: nextRunAt.toISOString(),
      }
    ).catch(() => {})

    return {
      handled: true,
      status: 'completed_deposit_pending',
      runId: run.id,
    }
  }
}

/**
 * Failure hook: invoked when a `FiatOrder` transitions to `FAILED` or `REFUNDED`.
 */
export async function handleFiatOrderFailedForPlan(
  fiatOrderId: string,
  failureReason: string,
  now: Date = new Date(),
  database: Db = db
): Promise<{ handled: boolean; status?: string; runId?: string }> {
  const run = await (database as any).fiatPurchasePlanRun?.findFirst({
    where: {
      OR: [
        { fiatOrderId },
        { fiatOrderIds: { has: fiatOrderId } },
      ],
    },
    include: { plan: true },
  })

  if (!run || !run.plan || isTerminalRunStatus(run.status)) {
    return { handled: false }
  }

  const retryPolicy = parseRetryPolicy(run.plan.retryPolicy)
  const res = await handleAttemptFailure(
    run.plan,
    run,
    failureReason,
    retryPolicy,
    now,
    database
  )
  return { handled: true, status: res.status, runId: res.runId }
}

/**
 * Sweep in-flight `FiatPurchasePlanRun` rows (`awaiting_settlement`,
 * `action_required`, `retrying`, `deferred_unhealthy`):
 *  - Reconciles settled/failed linked `FiatOrder`s
 *  - Fails `action_required` runs past `ACTION_TIMEOUT_MS`
 *  - Force-fails `awaiting_settlement` runs stuck past `RUN_STUCK_TIMEOUT_MS`
 *  - Executes due retries (`retrying` / `deferred_unhealthy` with `nextRetryAt <= now`)
 */
export async function sweepInFlightPlanRuns(
  now: Date = new Date(),
  database: Db = db
): Promise<{
  settled: number
  retried: number
  timedOut: number
  stuckFailed: number
}> {
  const inFlight = await (database as any).fiatPurchasePlanRun.findMany({
    where: {
      status: {
        in: [
          'awaiting_settlement',
          'action_required',
          'retrying',
          'deferred_unhealthy',
        ],
      },
    },
    include: { plan: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })

  let settled = 0
  let retried = 0
  let timedOut = 0
  let stuckFailed = 0

  for (const run of inFlight) {
    const plan = run.plan
    if (!plan) continue
    const retryPolicy = parseRetryPolicy(plan.retryPolicy)

    // 1. Check linked FiatOrder status if present
    if (
      run.fiatOrderId &&
      (run.status === 'awaiting_settlement' ||
        run.status === 'action_required')
    ) {
      const order = await (database as any).fiatOrder.findUnique({
        where: { id: run.fiatOrderId },
      })
      if (order?.status === 'SETTLED') {
        const res = await handleFiatOrderSettledForPlan(order.id, database)
        if (res.handled) settled++
        continue
      }
      if (order?.status === 'FAILED' || order?.status === 'REFUNDED') {
        await handleAttemptFailure(
          plan,
          run,
          order.failureReason ?? 'provider_order_failed',
          retryPolicy,
          now,
          database
        )
        continue
      }
    }

    // 2. Check 3-DS action timeout
    if (
      run.status === 'action_required' &&
      run.actionExpiresAt &&
      new Date(run.actionExpiresAt) <= now
    ) {
      timedOut++
      await handleAttemptFailure(
        plan,
        run,
        'action_timeout',
        retryPolicy,
        now,
        database
      )
      continue
    }

    // 3. Check stuck awaiting_settlement timeout
    if (run.status === 'awaiting_settlement') {
      const ageMs = now.getTime() - new Date(run.updatedAt).getTime()
      if (ageMs > RUN_STUCK_TIMEOUT_MS) {
        stuckFailed++
        const nextRunAt = addCadence(plan.cadence, new Date(run.scheduledFor))
        await (database as any).fiatPurchasePlanRun.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            failureReason: 'run_stuck_timeout',
            completedAt: now,
          },
        })
        await (database as any).fiatPurchasePlan.update({
          where: { id: plan.id },
          data: {
            lastRunStatus: 'failed_stuck_timeout',
            nextRunAt,
          },
        })
        await recordPlanAuditEntry(database, 'RUN_STUCK_FORCE_FAILED', {
          planId: plan.id,
          runId: run.id,
          fiatOrderId: run.fiatOrderId,
          ageMs,
          at: now.toISOString(),
        })
        await alertingService
          .emit(
            {
              title: 'FiatPurchasePlan run stuck awaiting settlement',
              description: `Plan ${plan.id} run ${run.id} (order ${run.fiatOrderId}) exceeded RUN_STUCK_TIMEOUT_MS and was force-failed. Its FiatOrder will continue reconciling independently.`,
              severity: 'critical',
              component: 'fiat-purchases',
              metadata: {
                planId: plan.id,
                runId: run.id,
                fiatOrderId: run.fiatOrderId,
                userId: plan.userId,
              },
            },
            `fiat-purchase:stuck:${run.id}`
          )
          .catch(() => {})
        publishUserEvent(
          plan.userId,
          EVENT_TYPE_TOPIC['fiat_purchase.failed'],
          'fiat_purchase.failed',
          {
            planId: plan.id,
            runId: run.id,
            orderId: run.fiatOrderId,
            userId: plan.userId,
            reason: 'run_stuck_timeout',
          }
        ).catch(() => {})
      }
      continue
    }

    // 4. Execute due retries (retrying or deferred_unhealthy)
    if (
      (run.status === 'retrying' || run.status === 'deferred_unhealthy') &&
      run.nextRetryAt &&
      new Date(run.nextRetryAt) <= now
    ) {
      if (plan.status !== 'ACTIVE') continue
      const nextAttempt =
        run.status === 'retrying' ? run.attemptCount + 1 : run.attemptCount
      const updatedRun = await (database as any).fiatPurchasePlanRun.update({
        where: { id: run.id },
        data: {
          attemptCount: nextAttempt,
          status: 'executing',
          nextRetryAt: null,
        },
      })
      retried++
      await submitOnRampAttemptForRun(
        plan,
        updatedRun,
        retryPolicy,
        Number(plan.fiatAmount),
        now,
        database
      )
    }
  }

  return { settled, retried, timedOut, stuckFailed }
}

/**
 * Generate a preview of the next `runs` scheduled fiat purchases for a plan.
 */
export function generateFiatPurchasePreview(params: {
  plan: {
    id: string
    fiatAmount: number | string | { toString(): string }
    fiatCurrency: string
    assetSymbol: string
    cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | string
    nextRunAt: Date | string
    autoDeposit: boolean
    maxSlippagePct?: number | string | { toString(): string } | null
    baselineRate?: number | string | { toString(): string } | null
  }
  runs: number
  liveRate?: number | null
}) {
  const fiatAmount = Number(params.plan.fiatAmount)
  const baselineRate =
    params.plan.baselineRate != null ? Number(params.plan.baselineRate) : null
  const rate =
    params.liveRate != null && params.liveRate > 0
      ? params.liveRate
      : baselineRate != null && baselineRate > 0
        ? baselineRate
        : 1
  const maxSlippagePct =
    params.plan.maxSlippagePct != null
      ? Number(params.plan.maxSlippagePct)
      : null

  const estimatedCryptoPerRun = Number((fiatAmount * rate).toFixed(8))
  const minCryptoPerRun =
    maxSlippagePct != null && baselineRate != null && baselineRate > 0
      ? Number(
          (fiatAmount * baselineRate * (1 - maxSlippagePct)).toFixed(8)
        )
      : null

  const schedule: Array<{
    occurrence: number
    scheduledFor: string
    fiatAmount: number
    fiatCurrency: string
    assetSymbol: string
    estimatedCryptoAmount: number
    minCryptoAmountAfterSlippage: number | null
    autoDeposit: boolean
  }> = []

  let cursor = new Date(params.plan.nextRunAt)
  for (let i = 0; i < params.runs; i++) {
    schedule.push({
      occurrence: i + 1,
      scheduledFor: cursor.toISOString(),
      fiatAmount,
      fiatCurrency: params.plan.fiatCurrency,
      assetSymbol: params.plan.assetSymbol,
      estimatedCryptoAmount: estimatedCryptoPerRun,
      minCryptoAmountAfterSlippage: minCryptoPerRun,
      autoDeposit: params.plan.autoDeposit,
    })
    cursor = addCadence(
      params.plan.cadence as 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY',
      cursor
    )
  }

  return {
    planId: params.plan.id,
    fiatAmount,
    fiatCurrency: params.plan.fiatCurrency,
    assetSymbol: params.plan.assetSymbol,
    cadence: params.plan.cadence,
    autoDeposit: params.plan.autoDeposit,
    referenceRate: rate,
    baselineRate,
    maxSlippagePct,
    disclosure: 'amount fixed in fiat, crypto received varies with rate',
    runs: schedule,
  }
}

/**
 * Main background job processor: sweeps in-flight runs and claims due plans.
 */
export async function processFiatPurchasePlans(
  now: Date = new Date(),
  database: Db = db
): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'fiat_purchases'

    try {
      const inFlightStats = await sweepInFlightPlanRuns(now, database)

      const duePlans = await (database as any).fiatPurchasePlan.findMany({
        where: {
          status: 'ACTIVE',
          nextRunAt: { lte: now },
        },
        orderBy: { nextRunAt: 'asc' },
        take: 200,
      })

      let claimedCount = 0
      for (const plan of duePlans) {
        const claimed = await claimDueFiatPurchasePlan(plan.id, now, database)
        if (!claimed) continue
        claimedCount++
        try {
          await executeFiatPurchasePlan(claimed, now, database)
        } catch (err) {
          logger.error('[FiatPurchase] Unexpected error executing plan', {
            planId: plan.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000
      logBackgroundJob(jobName, 'success', duration, correlationId, {
        dueCount: duePlans.length,
        claimedCount,
        ...inFlightStats,
      })
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000
      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: error instanceof Error ? error.message : String(error),
      })
      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs, error)
    }
  })
}

export function scheduleFiatPurchases(): NodeJS.Timeout {
  const handle = scheduleResilientJob({
    jobName: 'fiat_purchases',
    task: () => processFiatPurchasePlans(),
    intervalMs: FIAT_PURCHASES_INTERVAL_MS,
  })
  logger.info('[FiatPurchase] Scheduled fiat purchases job started', {
    intervalMs: FIAT_PURCHASES_INTERVAL_MS,
  })
  return handle
}
