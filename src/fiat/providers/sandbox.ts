/**
 * Sandbox fiat ramp provider (#313).
 *
 * A second, fully self-contained {@link FiatRampProvider} implementation that
 * exists to prove the multi-provider abstraction actually works: it can be
 * quoted, ordered, and reconciled through exactly the same code paths as
 * MoonPay, with no provider-specific branches anywhere outside this file.
 *
 * It makes no network calls — quotes are computed deterministically from a
 * small illustrative rate table — so it's useful in tests, local development,
 * and as a template for wiring a second real vendor. It is registered
 * automatically outside production (see `registry.ts`); set
 * FIAT_ENABLE_SANDBOX_PROVIDER=true|false to control it explicitly.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { logger } from '../../utils/logger'
import {
  CreateOrderRequest,
  CreateOrderResult,
  FeeBreakdown,
  FiatRampProvider,
  ParsedWebhook,
  QuoteRequest,
  QuoteResult,
} from '../types'

const PROVIDER_NAME = 'sandbox'

/** Illustrative crypto-units-per-1-fiat-unit rates. Not sourced from a live feed. */
const ASSET_RATES: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  XLM: 4,
}

function baseRateFor(assetSymbol: string): number {
  return ASSET_RATES[assetSymbol.toUpperCase()] ?? 1
}

function computeFees(fiatAmount: number): FeeBreakdown {
  const providerFeePct = Number(process.env.SANDBOX_PROVIDER_FEE_PCT || 0.005)
  const networkFeeFlat = Number(process.env.SANDBOX_NETWORK_FEE_FLAT || 0.1)
  return {
    providerFee: Number((fiatAmount * providerFeePct).toFixed(6)),
    networkFee: networkFeeFlat,
    fxSpread: 0,
  }
}

function kycThreshold(): number {
  return Number(process.env.SANDBOX_KYC_THRESHOLD || 1000)
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export class SandboxProvider implements FiatRampProvider {
  readonly name = PROVIDER_NAME

  private readonly webhookKey: string

  constructor(opts?: { webhookKey?: string }) {
    this.webhookKey =
      opts?.webhookKey ??
      process.env.SANDBOX_WEBHOOK_KEY ??
      (process.env.NODE_ENV === 'production'
        ? ''
        : 'sandbox-dev-webhook-secret')
  }

  async getQuote(req: QuoteRequest): Promise<QuoteResult> {
    const rate = baseRateFor(req.assetSymbol)
    const fees = computeFees(req.fiatAmount)
    const feeAmount = (fees.providerFee ?? 0) + (fees.networkFee ?? 0)

    const cryptoAmount =
      req.direction === 'ON_RAMP'
        ? Math.max(0, req.fiatAmount - feeAmount) * rate
        : (req.fiatAmount + feeAmount) * rate

    return {
      provider: this.name,
      direction: req.direction,
      fiatAmount: req.fiatAmount,
      fiatCurrency: req.fiatCurrency,
      assetSymbol: req.assetSymbol,
      cryptoAmount,
      feeAmount,
      rate,
      rateSource: 'PROVIDER',
      fees,
      unpriced: false,
      requiresKyc: req.fiatAmount > kycThreshold(),
      providerQuoteId: `sandbox_q_${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResult> {
    const providerOrderId = `sandbox_${randomUUID()}`
    const requiresKyc = req.fiatAmount > kycThreshold()
    const rate = baseRateFor(req.assetSymbol)
    const fees = computeFees(req.fiatAmount)
    const feeAmount = (fees.providerFee ?? 0) + (fees.networkFee ?? 0)
    const cryptoAmount =
      req.direction === 'ON_RAMP'
        ? Math.max(0, req.fiatAmount - feeAmount) * rate
        : (req.fiatAmount + feeAmount) * rate

    return {
      providerOrderId,
      checkoutUrl: `https://sandbox.fiat.local/checkout/${providerOrderId}`,
      kycUrl: requiresKyc
        ? `https://sandbox.fiat.local/kyc/${providerOrderId}`
        : undefined,
      status: requiresKyc ? 'KYC_REQUIRED' : 'PENDING',
      cryptoAmount,
    }
  }

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>
  ): boolean {
    if (!this.webhookKey) {
      logger.error(
        '[Sandbox] SANDBOX_WEBHOOK_KEY not configured — rejecting webhook'
      )
      return false
    }

    const header = headers['x-sandbox-signature']
    if (!header || !header.startsWith('sha256=')) return false
    const signature = header.slice('sha256='.length)

    const expected = createHmac('sha256', this.webhookKey)
      .update(rawBody)
      .digest('hex')

    return timingSafeEqualHex(expected, signature)
  }

  parseWebhookPayload(rawBody: string): ParsedWebhook {
    const data = JSON.parse(rawBody) as Record<string, any>
    return {
      providerOrderId: String(data.providerOrderId ?? data.id ?? ''),
      status: data.status ?? 'PENDING',
      txHash: data.txHash ?? undefined,
      cryptoAmount:
        data.cryptoAmount != null ? Number(data.cryptoAmount) : undefined,
      kycUrl: data.kycUrl ?? undefined,
      reason: data.reason ?? undefined,
    }
  }
}
