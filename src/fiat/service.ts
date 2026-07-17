/**
 * Fiat on-ramp / off-ramp service (#290).
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
 */
import db from '../db'
import { logger } from '../utils/logger'
import { dispatchWebhookEvent } from '../services/webhookDispatcher'
import { alertingService } from '../services/alerting'
import { getDefaultProvider, getProvider } from './registry'
import type {
  CreateFiatOrderInput,
  FiatQuoteInput,
} from '../validators/fiat-validators'
import type { NormalizedWebhookStatus, ParsedWebhook } from './types'

/** How long a PENDING/PROCESSING order may sit before the age-out job fails it. */
export const STALE_ORDER_MAX_AGE_MS = Number(
  process.env.FIAT_STALE_ORDER_MAX_AGE_MS || 24 * 60 * 60 * 1000,
)

type Db = typeof db

// ── Quotes ────────────────────────────────────────────────────────────────────

export async function getFiatQuote(input: FiatQuoteInput) {
  const provider = getDefaultProvider()
  return provider.getQuote({
    direction: input.direction,
    fiatAmount: input.fiatAmount,
    fiatCurrency: input.fiatCurrency,
    assetSymbol: input.assetSymbol,
  })
}

// ── Order creation ──────────────────────────────────────────────────────────

export interface CreateOrderContext {
  /** Authenticated user's custodial/destination Stellar address. */
  walletAddress: string
}

export async function createFiatOrder(
  input: CreateFiatOrderInput,
  ctx: CreateOrderContext,
  database: Db = db,
) {
  const provider = getDefaultProvider()

  const created = await provider.createOrder({
    userId: input.userId,
    direction: input.direction,
    fiatAmount: input.fiatAmount,
    fiatCurrency: input.fiatCurrency,
    assetSymbol: input.assetSymbol,
    walletAddress: ctx.walletAddress,
  })

  const initialStatus = mapToOrderStatus(created.status)

  const order = await (database as any).fiatOrder.create({
    data: {
      userId: input.userId,
      provider: provider.name,
      providerOrderId: created.providerOrderId,
      direction: input.direction,
      fiatAmount: input.fiatAmount,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: created.cryptoAmount ?? null,
      assetSymbol: input.assetSymbol,
      status: initialStatus,
      checkoutUrl: created.checkoutUrl ?? null,
      kycUrl: created.kycUrl ?? null,
    },
  })

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
 */
export async function processProviderWebhook(
  providerName: string,
  parsed: ParsedWebhook,
  database: Db = db,
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
    return { handled: true, reason: 'already terminal', orderId: order.id, status: order.status }
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
    dispatchWebhookEvent('fiat.order.failed', {
      orderId: updated.id,
      provider: providerName,
      direction: updated.direction,
      status: updated.status,
      failureReason: updated.failureReason,
      userId: updated.userId,
    }).catch(() => {})
  }

  // If the provider handed us a tx hash, try an immediate reconciliation pass
  // for this single order so settlement isn't delayed to the next sweep.
  if (parsed.txHash && updated.status === 'PROCESSING') {
    await reconcileSingleOrder(updated.id, parsed.txHash, database).catch((err) => {
      logger.error('[Fiat] Inline reconciliation failed', {
        orderId: updated.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  return { handled: true, orderId: updated.id, status: updated.status }
}

// ── Reconciliation against on-chain settlement ──────────────────────────────

/**
 * Try to settle one order against a specific claimed on-chain tx hash.
 * Settles only when a CONFIRMED Transaction row exists for that hash — i.e.
 * the Stellar event listener has independently observed the crypto leg.
 */
export async function reconcileSingleOrder(
  orderId: string,
  txHash: string,
  database: Db = db,
): Promise<boolean> {
  const order = await (database as any).fiatOrder.findUnique({ where: { id: orderId } })
  if (!order || isTerminal(order.status)) return false

  const tx = await (database as any).transaction.findUnique({ where: { txHash } })
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

  const settled = await (database as any).fiatOrder.update({
    where: { id: order.id },
    data: {
      status: 'SETTLED',
      transactionId: tx.id,
      settledAt: new Date(),
      cryptoAmount: order.cryptoAmount ?? tx.amount,
    },
  })

  logger.info('[Fiat] Order settled via on-chain confirmation', {
    orderId: settled.id,
    txHash,
  })

  dispatchWebhookEvent('fiat.order.settled', {
    orderId: settled.id,
    provider: settled.provider,
    direction: settled.direction,
    status: 'SETTLED',
    txHash,
    userId: settled.userId,
  }).catch(() => {})

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
    // Match on any CONFIRMED transaction for this user + asset that isn't
    // already linked to another fiat order. Provider-claimed hashes are handled
    // inline at webhook time; here we catch lost-webhook / async-settlement.
    const candidate = await (database as any).transaction.findFirst({
      where: {
        userId: order.userId,
        assetSymbol: order.assetSymbol,
        status: 'CONFIRMED',
        fiatOrders: { none: {} },
      },
      orderBy: { confirmedAt: 'desc' },
    })

    if (candidate) {
      const ok = await reconcileSingleOrder(order.id, candidate.txHash, database).catch(() => false)
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
              `PROCESSING for ${Math.round(ageMs / 3_600_000)}h with no confirmed on-chain transaction.`,
            severity: 'critical',
            component: 'fiat-reconciliation',
            metadata: {
              orderId: order.id,
              provider: order.provider,
              providerOrderId: order.providerOrderId,
              userId: order.userId,
            },
          },
          `fiat:stuck:${order.id}`,
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
export async function ageOutStaleFiatOrders(database: Db = db): Promise<{ failed: number }> {
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

export { getProvider }
