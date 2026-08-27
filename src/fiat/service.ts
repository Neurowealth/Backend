/**
 * Fiat on-ramp / off-ramp service (#290, extended #313 for multi-provider
 * best-execution and rate-drift protection).
 *
 * Design constraints baked in here:
 *
 *  1. Provider-agnostic. All vendor specifics live behind FiatRampProvider and
 *     are resolved through the registry — this file never branches on a vendor.
 *
 *  2. The provider webhook is NOT trusted as proof of settlement. A provider
 *     saying "completed" only advances an order to PROCESSING and records the
 *     tx hash it claims. An order becomes SETTLED only once the crypto leg is
 *     independently confirmed on-chain by the existing Stellar event listener
 *     (which upserts a CONFIRMED Transaction row keyed by txHash). This closes
 *     the gap where a provider reports success but funds never arrived — and
 *     the inverse (funds arrive, webhook lost) is caught by reconciliation.
 *
 *  3. Webhook processing is idempotent. Providers retry deliveries; we key on
 *     (provider, providerOrderId) and never double-apply a terminal state or
 *     re-emit a webhook event for an already-settled order.
 *
 *  4. Refund/failed handling. FAILED/REFUNDED are terminal; we persist the
 *     reason for user + operator visibility and emit an outbound webhook event.
 *
 *  5. Best execution (#313). GET-quote callers see every healthy provider's
 *     price in parallel, ranked. Order creation either pins a provider
 *     directly, references a time-boxed FiatQuoteLock from that ranked list,
 *     or falls back to the registry's selection policy — but once an order
 *     exists it is pinned to the provider that created it forever; failover
 *     only ever changes which provider a *new* order/quote goes to.
 *
 *  6. Rate-drift protection (#313). The quote captured at order creation
 *     (quoteRate/quotedCryptoAmount/fees) and the amount actually confirmed
 *     on-chain (settledRate/settledCryptoAmount) are both persisted, so a
 *     worse-than-quoted settlement is never silently absorbed — drift beyond
 *     tolerance raises an operational alert and a `fiat.order.rate_mismatch`
 *     webhook. Over-delivery (a better-than-quoted settlement) is credited to
 *     the user, not capped — it's still reported for audit visibility.
 */
import db from '../db'
import { logger } from '../utils/logger'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { alertingService } from '../services/alerting'
import {
  getDefaultProvider,
  getProvider,
  getHealthyProviders,
  getAllProviderHealth,
  recordProviderSuccess,
  recordProviderFailure,
  selectProviderForOrder,
} from './registry'
import {
  recordFiatQuoteLatency,
  recordFiatQuoteFailure,
  recordFiatOrder,
  recordFiatRateDrift,
} from '../utils/metrics'
import type {
  CreateFiatOrderInput,
  FiatQuoteInput,
} from '../validators/fiat-validators'
import type {
  BestExecutionQuoteResult,
  ExcludedProviderQuote,
  FiatDirection,
  NormalizedWebhookStatus,
  ParsedWebhook,
  ProviderSelectionPolicy,
  QuoteResult,
  RankedQuote,
} from './types'
import { NoHealthyProvidersError, FiatOrderError } from './types'

/** How long a PENDING/PROCESSING order may sit before the age-out job fails it. */
export const STALE_ORDER_MAX_AGE_MS = Number(
  process.env.FIAT_STALE_ORDER_MAX_AGE_MS || 24 * 60 * 60 * 1000
)

/** How long a quote returned by getBestExecutionQuote stays honorable (#313). */
export const QUOTE_LOCK_TTL_MS = Number(
  process.env.FIAT_QUOTE_LOCK_TTL_MS || 60_000
)

/** Per-provider timeout for a single quote request in the parallel fan-out. */
const QUOTE_PROVIDER_TIMEOUT_MS = Number(
  process.env.FIAT_QUOTE_PROVIDER_TIMEOUT_MS || 8_000
)

/** Beyond this |settled - quoted| / quoted, emit a rate-drift alert + webhook. */
export const RATE_DRIFT_TOLERANCE_PCT = Number(
  process.env.FIAT_RATE_DRIFT_TOLERANCE_PCT || 0.02
)

/** Beyond this drift, escalate to critical — flags the order for manual re-quote/refund review. */
export const RATE_DRIFT_CRITICAL_PCT = Number(
  process.env.FIAT_RATE_DRIFT_CRITICAL_PCT || 0.1
)

/**
 * How close a candidate on-chain transaction's amount must be to an order's
 * quoted crypto amount to be considered a match during reconciliation.
 * Deliberately looser than RATE_DRIFT_TOLERANCE_PCT (a legitimate settlement
 * may itself drift a little) — this exists to stop the "any unlinked
 * confirmed transaction for this user+asset" heuristic from cross-linking two
 * different providers' concurrent orders for the same user/asset (#313).
 */
export const RECONCILE_AMOUNT_TOLERANCE_PCT = Number(
  process.env.FIAT_RECONCILE_AMOUNT_TOLERANCE_PCT || 0.05
)

type Db = typeof db

export { FiatOrderError }

// ── Quotes ────────────────────────────────────────────────────────────────────

export async function getFiatQuote(input: FiatQuoteInput) {
  const provider = selectProviderForOrder({ policy: 'DEFAULT' })
  try {
    const quote = await provider.getQuote({
      direction: input.direction,
      fiatAmount: input.fiatAmount,
      fiatCurrency: input.fiatCurrency,
      assetSymbol: input.assetSymbol,
    })
    recordProviderSuccess(provider.name)
    return quote
  } catch (err) {
    recordProviderFailure(provider.name)
    throw err
  }
}

/** Race a provider quote against a timeout so one slow vendor never blocks the fan-out. */
async function quoteWithTimeout(
  providerName: string,
  fn: () => Promise<QuoteResult>,
  timeoutMs: number
): Promise<QuoteResult> {
  return new Promise<QuoteResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Quote request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    fn()
      .then((r) => {
        clearTimeout(timer)
        resolve(r)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

/** Best executable quote for the given direction: higher cryptoAmount is better on-ramp, lower is better off-ramp. */
function isBetterQuote(
  a: QuoteResult,
  b: QuoteResult,
  direction: FiatDirection
): boolean {
  if (direction === 'ON_RAMP') return a.cryptoAmount > b.cryptoAmount
  return a.cryptoAmount < b.cryptoAmount
}

/**
 * Query every healthy provider in parallel, normalize + rank the results, and
 * persist a time-boxed {@link FiatQuoteLock} per successful quote so the
 * caller (or a subsequent order-creation call) can reference one by id.
 *
 * Never throws for partial failure — a provider that times out or errors is
 * moved to `excluded` with a reason and the rest of the ranking proceeds.
 * Throws {@link NoHealthyProvidersError} only when no provider could be
 * reached at all.
 */
export async function getBestExecutionQuote(
  input: FiatQuoteInput,
  ctx: { userId: string },
  database: Db = db
): Promise<BestExecutionQuoteResult> {
  const providers = getHealthyProviders()

  if (providers.length === 0) {
    throw new NoHealthyProvidersError(
      getAllProviderHealth().map((h) => ({
        provider: h.provider,
        reason: `circuit ${h.state} after ${h.consecutiveFailures} consecutive failures`,
      }))
    )
  }

  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const start = Date.now()
      try {
        const quote = await quoteWithTimeout(
          provider.name,
          () =>
            provider.getQuote({
              direction: input.direction,
              fiatAmount: input.fiatAmount,
              fiatCurrency: input.fiatCurrency,
              assetSymbol: input.assetSymbol,
            }),
          QUOTE_PROVIDER_TIMEOUT_MS
        )
        recordProviderSuccess(provider.name)
        recordFiatQuoteLatency(
          provider.name,
          input.direction,
          (Date.now() - start) / 1000
        )
        return quote
      } catch (err) {
        recordProviderFailure(provider.name)
        recordFiatQuoteLatency(
          provider.name,
          input.direction,
          (Date.now() - start) / 1000
        )
        const reason = err instanceof Error ? err.message : String(err)
        recordFiatQuoteFailure(provider.name, reason)
        throw new Error(`${provider.name}: ${reason}`)
      }
    })
  )

  const successes: QuoteResult[] = []
  const excluded: ExcludedProviderQuote[] = []

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      successes.push(result.value)
    } else {
      const providerName = providers[i].name
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      excluded.push({ provider: providerName, reason })
    }
  })

  successes.sort((a, b) => (isBetterQuote(a, b, input.direction) ? -1 : 1))

  const expiresAt = new Date(Date.now() + QUOTE_LOCK_TTL_MS)
  const ranked: RankedQuote[] = []

  for (let i = 0; i < successes.length; i++) {
    const q = successes[i]
    const lock = await (database as any).fiatQuoteLock.create({
      data: {
        userId: ctx.userId,
        provider: q.provider,
        direction: q.direction,
        fiatAmount: q.fiatAmount,
        fiatCurrency: q.fiatCurrency,
        assetSymbol: q.assetSymbol,
        cryptoAmount: q.cryptoAmount,
        rate: q.rate ?? null,
        fees: q.fees as any,
        providerQuoteId: q.providerQuoteId ?? null,
        expiresAt,
      },
    })
    ranked.push({
      ...q,
      quoteId: lock.id,
      expiresAt: expiresAt.toISOString(),
      rank: i + 1,
    })
  }

  return { best: ranked[0] ?? null, quotes: ranked, excluded }
}

// ── Order creation ──────────────────────────────────────────────────────────

export interface CreateOrderContext {
  /** Authenticated user's custodial/destination Stellar address. */
  walletAddress: string
}

async function resolveOrderProvider(
  input: CreateFiatOrderInput,
  database: Db
): Promise<{
  providerName: string
  quoteRate: number | null
  quotedCryptoAmount: number | null
  fees: unknown
  providerQuoteId: string | null
  rateLockExpiresAt: Date | null
  lockId: string | null
}> {
  if (input.quoteId) {
    const lock = await (database as any).fiatQuoteLock.findUnique({
      where: { id: input.quoteId },
    })

    if (!lock || lock.userId !== input.userId) {
      throw new FiatOrderError('quote_not_found', 404, 'Quote not found')
    }
    if (lock.consumedAt) {
      throw new FiatOrderError(
        'quote_already_used',
        409,
        'This quote has already been used to create an order'
      )
    }
    if (new Date(lock.expiresAt).getTime() < Date.now()) {
      throw new FiatOrderError(
        'quote_expired',
        409,
        'Quote is no longer valid — request a fresh quote',
        { freshQuoteUrl: '/api/v1/fiat/quotes' }
      )
    }
    if (
      lock.direction !== input.direction ||
      lock.fiatCurrency !== input.fiatCurrency ||
      lock.assetSymbol !== input.assetSymbol ||
      Number(lock.fiatAmount) !== input.fiatAmount
    ) {
      throw new FiatOrderError(
        'quote_mismatch',
        409,
        'Order parameters do not match the locked quote'
      )
    }

    return {
      providerName: lock.provider,
      quoteRate: lock.rate != null ? Number(lock.rate) : null,
      quotedCryptoAmount: Number(lock.cryptoAmount),
      fees: lock.fees,
      providerQuoteId: lock.providerQuoteId,
      rateLockExpiresAt: lock.expiresAt,
      lockId: lock.id,
    }
  }

  const policy = (process.env.FIAT_PROVIDER_SELECTION_POLICY ||
    'DEFAULT') as ProviderSelectionPolicy
  const provider = selectProviderForOrder({
    policy: input.provider ? 'PREFER_PROVIDER' : policy,
    preferredProvider: input.provider,
  })

  try {
    const quote = await provider.getQuote({
      direction: input.direction,
      fiatAmount: input.fiatAmount,
      fiatCurrency: input.fiatCurrency,
      assetSymbol: input.assetSymbol,
    })
    recordProviderSuccess(provider.name)
    return {
      providerName: provider.name,
      quoteRate: quote.rate ?? null,
      quotedCryptoAmount: quote.cryptoAmount,
      fees: quote.fees as any,
      providerQuoteId: quote.providerQuoteId ?? null,
      rateLockExpiresAt: new Date(Date.now() + QUOTE_LOCK_TTL_MS),
      lockId: null,
    }
  } catch (err) {
    recordProviderFailure(provider.name)
    throw err
  }
}

export async function createFiatOrder(
  input: CreateFiatOrderInput,
  ctx: CreateOrderContext,
  database: Db = db
) {
  const resolved = await resolveOrderProvider(input, database)
  const provider = getProvider(resolved.providerName)

  let created
  try {
    created = await provider.createOrder({
      userId: input.userId,
      direction: input.direction,
      fiatAmount: input.fiatAmount,
      fiatCurrency: input.fiatCurrency,
      assetSymbol: input.assetSymbol,
      walletAddress: ctx.walletAddress,
    })
    recordProviderSuccess(provider.name)
  } catch (err) {
    recordProviderFailure(provider.name)
    recordFiatOrder(provider.name, 'CREATE_FAILED')
    throw err
  }

  const initialStatus = mapToOrderStatus(created.status)

  const order = await (database as any).fiatOrder.create({
    data: {
      userId: input.userId,
      provider: provider.name,
      providerOrderId: created.providerOrderId,
      direction: input.direction,
      fiatAmount: input.fiatAmount,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: created.cryptoAmount ?? resolved.quotedCryptoAmount ?? null,
      assetSymbol: input.assetSymbol,
      status: initialStatus,
      checkoutUrl: created.checkoutUrl ?? null,
      kycUrl: created.kycUrl ?? null,
      quoteRate: resolved.quoteRate,
      quotedCryptoAmount: resolved.quotedCryptoAmount,
      fees: resolved.fees as any,
      providerQuoteId: resolved.providerQuoteId,
      rateLockExpiresAt: resolved.rateLockExpiresAt,
    },
  })

  if (resolved.lockId) {
    await (database as any).fiatQuoteLock
      .update({
        where: { id: resolved.lockId },
        data: { consumedAt: new Date() },
      })
      .catch((err: unknown) => {
        // Non-fatal: the order is already created. Worst case the same quote
        // could be raced onto a second order — logged for investigation.
        logger.error('[Fiat] Failed to mark quote lock consumed', {
          quoteId: resolved.lockId,
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  recordFiatOrder(provider.name, initialStatus)

  logger.info('[Fiat] Order created', {
    orderId: order.id,
    provider: provider.name,
    providerOrderId: created.providerOrderId,
    direction: input.direction,
    status: initialStatus,
  })

  return order
}

// ── Webhook processing (idempotent) ─────────────────────────────────────────

export interface ProcessWebhookResult {
  handled: boolean
  reason?: string
  orderId?: string
  status?: string
}

/**
 * Apply a verified, parsed provider webhook to the matching order.
 *
 * Idempotent: safe to call repeatedly for the same delivery. Terminal states
 * (SETTLED/FAILED/REFUNDED) are never overwritten, and a provider "completed"
 * callback only advances the order to PROCESSING — never SETTLED — because
 * on-chain confirmation is authoritative (see reconcileFiatOrders).
 *
 * Keyed on (provider, providerOrderId) — a webhook from provider A can never
 * mutate an order created by provider B, even if the providerOrderId strings
 * happened to collide, because the unique constraint is on the pair (#313).
 */
export async function processProviderWebhook(
  providerName: string,
  parsed: ParsedWebhook,
  database: Db = db
): Promise<ProcessWebhookResult> {
  if (!parsed.providerOrderId) {
    return { handled: false, reason: 'missing providerOrderId' }
  }

  const order = await (database as any).fiatOrder.findUnique({
    where: {
      provider_providerOrderId: {
        provider: providerName,
        providerOrderId: parsed.providerOrderId,
      },
    },
  })

  if (!order) {
    // Unknown order — acknowledge without side effects so the provider stops
    // retrying, but log for investigation (could be a spoof or a cross-env id).
    logger.warn('[Fiat] Webhook for unknown order', {
      provider: providerName,
      providerOrderId: parsed.providerOrderId,
    })
    return { handled: false, reason: 'unknown order' }
  }

  // Terminal states are immutable — drop duplicate/late deliveries.
  if (isTerminal(order.status)) {
    return {
      handled: true,
      reason: 'already terminal',
      orderId: order.id,
      status: order.status,
    }
  }

  const data: Record<string, unknown> = { updatedAt: new Date() }

  if (parsed.cryptoAmount != null && order.cryptoAmount == null) {
    data.cryptoAmount = parsed.cryptoAmount
  }
  if (parsed.kycUrl) {
    data.kycUrl = parsed.kycUrl
  }

  switch (parsed.status) {
    case 'KYC_REQUIRED':
      // Still open; surface the KYC link but keep the order actionable.
      data.status = 'PENDING'
      break
    case 'PENDING':
      data.status = 'PENDING'
      break
    case 'PROCESSING':
    case 'SETTLED':
      // Provider claims payment success. Do NOT mark SETTLED here — on-chain
      // confirmation is authoritative. Advance to PROCESSING and stash the
      // claimed tx hash so reconciliation can match it.
      data.status = 'PROCESSING'
      break
    case 'FAILED':
      data.status = 'FAILED'
      data.failureReason = parsed.reason ?? 'Provider reported failure'
      break
    case 'REFUNDED':
      data.status = 'REFUNDED'
      data.failureReason = parsed.reason ?? 'Provider refunded the payment'
      break
  }

  const updated = await (database as any).fiatOrder.update({
    where: { id: order.id },
    data,
  })

  // Emit outbound webhook for terminal failure/refund so subscribers react.
  if (updated.status === 'FAILED' || updated.status === 'REFUNDED') {
    recordFiatOrder(providerName, updated.status)
    publishUserEvent(
      updated.userId,
      EVENT_TYPE_TOPIC['fiat.order.failed'],
      'fiat.order.failed',
      {
        orderId: updated.id,
        provider: providerName,
        direction: updated.direction,
        status: updated.status,
        failureReason: updated.failureReason,
        userId: updated.userId,
      }
    ).catch(() => {})
  }

  // If the provider handed us a tx hash, try an immediate reconciliation pass
  // for this single order so settlement isn't delayed to the next sweep.
  if (parsed.txHash && updated.status === 'PROCESSING') {
    await reconcileSingleOrder(updated.id, parsed.txHash, database).catch(
      (err) => {
        logger.error('[Fiat] Inline reconciliation failed', {
          orderId: updated.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    )
  }

  return { handled: true, orderId: updated.id, status: updated.status }
}

// ── Reconciliation against on-chain settlement ──────────────────────────────

/**
 * Try to settle one order against a specific claimed on-chain tx hash.
 * Settles only when a CONFIRMED Transaction row exists for that hash — i.e.
 * the Stellar event listener has independently observed the crypto leg.
 *
 * Also computes and persists the quoted-vs-settled delta (#313): when the
 * order carries a quotedCryptoAmount, the realized settledCryptoAmount/
 * settledRate are compared against it, and drift beyond
 * RATE_DRIFT_TOLERANCE_PCT raises an operational alert plus a
 * `fiat.order.rate_mismatch` webhook. Over-delivery is credited (the order's
 * original `cryptoAmount` — what the user was promised — is never reduced);
 * this only ever adds visibility, never claws back a better-than-quoted fill.
 */
export async function reconcileSingleOrder(
  orderId: string,
  txHash: string,
  database: Db = db
): Promise<boolean> {
  const order = await (database as any).fiatOrder.findUnique({
    where: { id: orderId },
  })
  if (!order || isTerminal(order.status)) return false

  const tx = await (database as any).transaction.findUnique({
    where: { txHash },
  })
  if (!tx || tx.status !== 'CONFIRMED') return false
  if (tx.userId !== order.userId) {
    // Hash belongs to a different user — never cross-link funds.
    logger.error('[Fiat] Claimed txHash user mismatch — refusing to link', {
      orderId,
      txHash,
      orderUser: order.userId,
      txUser: tx.userId,
    })
    return false
  }

  const settledCryptoAmount = Number(tx.amount)
  const quotedCryptoAmount =
    order.quotedCryptoAmount != null
      ? Number(order.quotedCryptoAmount)
      : order.cryptoAmount != null
        ? Number(order.cryptoAmount)
        : null
  const fiatAmount = Number(order.fiatAmount)

  let settledRate: number | null = null
  let driftPct: number | null = null
  if (quotedCryptoAmount && quotedCryptoAmount > 0) {
    driftPct = (settledCryptoAmount - quotedCryptoAmount) / quotedCryptoAmount
    settledRate = fiatAmount > 0 ? settledCryptoAmount / fiatAmount : null
  }

  const settled = await (database as any).fiatOrder.update({
    where: { id: order.id },
    data: {
      status: 'SETTLED',
      transactionId: tx.id,
      settledAt: new Date(),
      cryptoAmount: order.cryptoAmount ?? tx.amount,
      settledCryptoAmount,
      settledRate,
    },
  })

  logger.info('[Fiat] Order settled via on-chain confirmation', {
    orderId: settled.id,
    txHash,
    driftPct,
  })

  recordFiatOrder(order.provider, 'SETTLED')

  publishUserEvent(
    settled.userId,
    EVENT_TYPE_TOPIC['fiat.order.settled'],
    'fiat.order.settled',
    {
      orderId: settled.id,
      provider: settled.provider,
      direction: settled.direction,
      status: 'SETTLED',
      txHash,
      userId: settled.userId,
    }
  ).catch(() => {})

  if (driftPct !== null) {
    recordFiatRateDrift(order.provider, order.direction, Math.abs(driftPct))

    if (Math.abs(driftPct) > RATE_DRIFT_TOLERANCE_PCT) {
      const critical = Math.abs(driftPct) > RATE_DRIFT_CRITICAL_PCT
      alertingService
        .emit(
          {
            title: 'Fiat order settled with rate drift beyond tolerance',
            description:
              `Order ${order.id} (${order.provider}) settled ${(driftPct * 100).toFixed(2)}% ` +
              `${driftPct < 0 ? 'below' : 'above'} the quoted crypto amount.` +
              (critical
                ? ' Drift exceeds the critical threshold — review for re-quote/refund.'
                : ''),
            severity: critical ? 'critical' : 'warning',
            component: 'fiat-settlement',
            metadata: {
              orderId: order.id,
              provider: order.provider,
              direction: order.direction,
              driftPct,
            },
          },
          `fiat:drift:${order.id}`
        )
        .catch(() => {})

      publishUserEvent(
        order.userId,
        EVENT_TYPE_TOPIC['fiat.order.rate_mismatch'],
        'fiat.order.rate_mismatch',
        {
          orderId: order.id,
          provider: order.provider,
          direction: order.direction,
          quotedCryptoAmount,
          settledCryptoAmount,
          driftPct,
          userId: order.userId,
        }
      ).catch(() => {})
    }
  }

  return true
}

/**
 * Sweep PROCESSING orders and settle any whose crypto leg is now confirmed
 * on-chain. Also emits an operational alert for orders the provider reported as
 * paid but which have no matching confirmed on-chain transaction after the
 * stale threshold — the "provider says settled, chain disagrees" case.
 */
export async function reconcileFiatOrders(database: Db = db): Promise<{
  scanned: number
  settled: number
}> {
  const processing = await (database as any).fiatOrder.findMany({
    where: { status: 'PROCESSING' },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })

  let settled = 0
  for (const order of processing) {
    // Match against unlinked CONFIRMED transactions for this user + asset.
    // Provider-claimed hashes are handled inline at webhook time; here we
    // catch lost-webhook / async-settlement. With multiple providers able to
    // have concurrent PROCESSING orders for the same user + asset, matching
    // on "most recent unlinked" alone can cross-link an order to a
    // transaction that actually belongs to a *different* provider's order —
    // so once an order has a quoted crypto amount on record, only a
    // transaction whose amount falls within RECONCILE_AMOUNT_TOLERANCE_PCT of
    // that quote is eligible (#313).
    const candidates = await (database as any).transaction.findMany({
      where: {
        userId: order.userId,
        assetSymbol: order.assetSymbol,
        status: 'CONFIRMED',
        fiatOrders: { none: {} },
      },
      orderBy: { confirmedAt: 'desc' },
      take: 20,
    })

    const expectedAmount =
      order.quotedCryptoAmount != null
        ? Number(order.quotedCryptoAmount)
        : order.cryptoAmount != null
          ? Number(order.cryptoAmount)
          : null

    let candidate: any = null
    if (expectedAmount != null && expectedAmount > 0) {
      candidate =
        candidates.find((c: any) => {
          const amt = Number(c.amount)
          return (
            Math.abs(amt - expectedAmount) / expectedAmount <=
            RECONCILE_AMOUNT_TOLERANCE_PCT
          )
        }) ?? null

      if (!candidate && candidates.length > 0) {
        logger.warn(
          '[Fiat] Confirmed transactions exist for user+asset but none match this order within tolerance — refusing to cross-link',
          {
            orderId: order.id,
            provider: order.provider,
            expectedAmount,
            candidateCount: candidates.length,
          }
        )
      }
    } else {
      // Legacy order with no recorded quote amount — degraded match against
      // the most recent unlinked transaction, same as pre-#313 behavior.
      candidate = candidates[0] ?? null
    }

    if (candidate) {
      const ok = await reconcileSingleOrder(
        order.id,
        candidate.txHash,
        database
      ).catch(() => false)
      if (ok) settled++
      continue
    }

    // No on-chain match yet. If it's been stuck too long, alert operators —
    // this is the provider-settled-but-chain-empty discrepancy.
    const ageMs = Date.now() - new Date(order.createdAt).getTime()
    if (ageMs > STALE_ORDER_MAX_AGE_MS) {
      await alertingService
        .emit(
          {
            title: 'Fiat order stuck in PROCESSING without on-chain settlement',
            description:
              `Order ${order.id} (${order.provider}/${order.providerOrderId}) has been ` +
              `PROCESSING for ${Math.round(ageMs / 3_600_000)}h with no confirmed on-chain transaction. ` +
              `Quoted crypto amount: ${expectedAmount ?? 'unknown'}.`,
            severity: 'critical',
            component: 'fiat-reconciliation',
            metadata: {
              orderId: order.id,
              provider: order.provider,
              providerOrderId: order.providerOrderId,
              userId: order.userId,
              quotedCryptoAmount: expectedAmount,
            },
          },
          `fiat:stuck:${order.id}`
        )
        .catch(() => {})
    }
  }

  return { scanned: processing.length, settled }
}

/**
 * Age-out job: fail orders left PENDING (never paid) past the stale threshold
 * so they don't linger forever. PROCESSING orders are left to reconciliation +
 * alerting, because funds may still be in flight.
 */
export async function ageOutStaleFiatOrders(
  database: Db = db
): Promise<{ failed: number }> {
  const cutoff = new Date(Date.now() - STALE_ORDER_MAX_AGE_MS)

  const stale = await (database as any).fiatOrder.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
  })

  let failed = 0
  for (const { id } of stale) {
    await (database as any).fiatOrder.update({
      where: { id },
      data: {
        status: 'FAILED',
        failureReason: 'Order expired before payment was completed',
        updatedAt: new Date(),
      },
    })
    failed++
  }

  if (failed > 0) {
    logger.info('[Fiat] Aged out stale PENDING orders', { failed })
  }

  return { failed }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapToOrderStatus(status: NormalizedWebhookStatus): string {
  switch (status) {
    case 'SETTLED':
    case 'PROCESSING':
      // Never persist SETTLED from a provider signal at creation.
      return 'PROCESSING'
    case 'FAILED':
      return 'FAILED'
    case 'REFUNDED':
      return 'REFUNDED'
    case 'KYC_REQUIRED':
    case 'PENDING':
    default:
      return 'PENDING'
  }
}

function isTerminal(status: string): boolean {
  return status === 'SETTLED' || status === 'FAILED' || status === 'REFUNDED'
}

export { getProvider, getDefaultProvider }
