/**
 * Transak fiat ramp provider (#399) — the second live buy/sell vendor, added
 * so a MoonPay outage can fail over to a working alternative (regulatory
 * restrictions permitting). Everything Transak-specific (endpoints, request/
 * response shapes, and the webhook signature scheme) is contained here, behind
 * FiatRampProvider.
 *
 * Webhook verification follows Transak's scheme: the `x-transak-signature`
 * header carries an HMAC-SHA256 of the raw request body, hex-encoded, keyed by
 * the webhook secret. Transak normally signs webhooks with the account API
 * secret, so TRANSAK_WEBHOOK_SECRET overrides it when a dedicated webhook key
 * is configured. We compare with a timing-safe equality check and never throw
 * from verification.
 * https://docs.transak.com/docs/webhooks
 */
import { createHmac, timingSafeEqual } from 'crypto'
import { logger } from '../../utils/logger'
import { HttpClientAdapter } from '../../utils/http-client'
import { config } from '../../config/env'
import {
  CreateOrderRequest,
  CreateOrderResult,
  FiatRampProvider,
  NormalizedWebhookStatus,
  ParsedWebhook,
  QuoteRequest,
  QuoteResult,
} from '../types'

const PROVIDER_NAME = 'transak'

/** Map Transak's raw order statuses onto our normalized set. */
function normalizeStatus(raw: string | undefined): NormalizedWebhookStatus {
  switch ((raw || '').toUpperCase()) {
    case 'SUCCESS_COMPLETED':
      return 'SETTLED'
    case 'AWAITING_PAYMENT_FROM_USER':
    case 'INITIATED':
    case 'PENDING':
      return 'PENDING'
    case 'PAYMENT_DONE':
    case 'PROCESSING':
    case 'PROCESSING_WITHOUT_KYC':
    case 'IN_PROGRESS':
      return 'PROCESSING'
    case 'ON_HOLD_FOR_KYC':
      return 'KYC_REQUIRED'
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELLED':
    case 'QUOTE_EXPIRED':
      return 'FAILED'
    case 'REFUNDED':
      return 'REFUNDED'
    default:
      return 'PENDING'
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  // Length mismatch => not equal, and avoid Buffer length throw in timingSafeEqual.
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export class TransakProvider implements FiatRampProvider {
  readonly name = PROVIDER_NAME

  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly webhookSecret: string
  private readonly baseUrl: string
  private readonly network: string
  private readonly http: HttpClientAdapter

  constructor(opts?: {
    apiKey?: string
    apiSecret?: string
    webhookSecret?: string
    baseUrl?: string
    network?: string
  }) {
    this.apiKey = opts?.apiKey ?? process.env.TRANSAK_API_KEY ?? ''
    this.apiSecret = opts?.apiSecret ?? process.env.TRANSAK_API_SECRET ?? ''
    this.webhookSecret =
      opts?.webhookSecret ?? process.env.TRANSAK_WEBHOOK_SECRET ?? ''
    this.baseUrl =
      opts?.baseUrl ??
      process.env.TRANSAK_API_BASE_URL ??
      'https://api.transak.com'
    this.network = opts?.network ?? process.env.TRANSAK_NETWORK ?? 'mainnet'
    this.http = new HttpClientAdapter({
      timeoutMs: config.httpClient.timeoutMs,
      maxRetries: config.httpClient.maxRetries,
      baseDelayMs: config.httpClient.baseDelayMs,
      maxDelayMs: config.httpClient.maxDelayMs,
      circuitBreakerThreshold: config.httpClient.circuitBreakerThreshold,
      circuitBreakerResetMs: config.httpClient.circuitBreakerResetMs,
    })
  }

  async getQuote(req: QuoteRequest): Promise<QuoteResult> {
    const isBuy = req.direction === 'ON_RAMP'

    const url =
      `${this.baseUrl}/api/v2/pricing/public/quotes` +
      `?apiKey=${encodeURIComponent(this.apiKey)}` +
      `&fiatCurrency=${encodeURIComponent(req.fiatCurrency)}` +
      `&cryptoCurrency=${encodeURIComponent(req.assetSymbol)}` +
      `&network=${encodeURIComponent(this.network)}` +
      `&isBuyOrSell=${isBuy ? 'BUY' : 'SELL'}` +
      `&fiatAmount=${encodeURIComponent(String(req.fiatAmount))}`

    const data = await this.http.execute(async () => {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Transak quote failed: HTTP ${res.status}`)
      }
      return (await res.json()) as Record<string, unknown>
    }, 'transak.getQuote')

    // Transak's public pricing comes back as quotes[fiat][crypto] → a single
    // priced element whose `price` is the fiat cost of ONE crypto unit.
    const quotes = data.quotes as Record<string, any> | undefined
    const perFiat =
      quotes?.[req.fiatCurrency] ?? quotes?.[req.fiatCurrency.toLowerCase()]
    const perAsset =
      perFiat?.[req.assetSymbol] ?? perFiat?.[req.assetSymbol.toLowerCase()]
    const first = Array.isArray(perAsset) ? perAsset[0] : perAsset

    const price = Number(first?.price ?? 0)
    const fee = Number(first?.fee ?? 0)
    const cryptoAmount = price > 0 ? req.fiatAmount / price : 0
    const rate = price > 0 ? 1 / price : undefined

    // Transak reports a single total fee, not an itemized breakdown — so only
    // providerFee is populated and the quote is labelled unpriced when the
    // price element gave us no fee at all.
    const hasFeeData = Number.isFinite(fee) && fee > 0
    const fees = hasFeeData
      ? { providerFee: fee, networkFee: null, fxSpread: null }
      : null

    return {
      provider: this.name,
      direction: req.direction,
      fiatAmount: req.fiatAmount,
      fiatCurrency: req.fiatCurrency,
      assetSymbol: req.assetSymbol,
      cryptoAmount,
      feeAmount: hasFeeData ? fee : undefined,
      rate,
      rateSource: 'PROVIDER',
      fees,
      unpriced: fees === null,
    }
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResult> {
    // Transak's primary integration is a hosted widget; server-side we
    // register an order intent and hand back the hosted checkout URL.
    const isBuy = req.direction === 'ON_RAMP'

    const params = new URLSearchParams()
    params.set('apiKey', this.apiKey)
    params.set('type', isBuy ? 'BUY' : 'SELL')
    params.set('fiatCurrency', req.fiatCurrency)
    params.set('cryptoCurrency', req.assetSymbol)
    params.set('network', this.network)
    params.set('fiatAmount', String(req.fiatAmount))
    params.set('walletAddress', req.walletAddress)
    params.set('partnerCustomerId', req.userId)

    const url = `${this.baseUrl}/api/v2/order?${params.toString()}`

    const body = JSON.stringify({
      orderType: isBuy ? 'BUY' : 'SELL',
      fiatCurrency: req.fiatCurrency,
      fiatAmount: req.fiatAmount,
      cryptoCurrency: req.assetSymbol,
      network: this.network,
      walletAddress: req.walletAddress,
      partnerCustomerId: req.userId,
    })

    const data = await this.http.execute(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      })
      if (!res.ok) {
        throw new Error(`Transak createOrder failed: HTTP ${res.status}`)
      }
      return (await res.json()) as Record<string, unknown>
    }, 'transak.createOrder')

    const providerOrderId = String(data.id ?? '')
    if (!providerOrderId) {
      throw new Error('Transak createOrder returned no order id')
    }

    return {
      providerOrderId,
      checkoutUrl:
        (data.checkoutUrl as string) ?? (data.widgetUrl as string) ?? undefined,
      kycUrl: (data.kycLink as string) ?? undefined,
      status: normalizeStatus(data.status as string | undefined),
      cryptoAmount: Number(data.cryptoAmount ?? 0) || undefined,
    }
  }

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>
  ): boolean {
    // Transak signs webhooks with the account API secret; a dedicated webhook
    // secret overrides it so the webhook credential can be isolated.
    const signingKey = this.webhookSecret || this.apiSecret
    if (!signingKey) {
      // No configured secret means we cannot verify — reject rather than trust.
      logger.error(
        '[Transak] TRANSAK_API_SECRET/TRANSAK_WEBHOOK_SECRET not configured — rejecting webhook'
      )
      return false
    }

    const header =
      headers['x-transak-signature'] ??
      headers['X-Transak-Signature'] ??
      headers['transak-signature']
    if (!header) return false

    const expected = createHmac('sha256', signingKey)
      .update(rawBody)
      .digest('hex')

    return timingSafeEqualHex(expected, header.trim())
  }

  parseWebhookPayload(rawBody: string): ParsedWebhook {
    const parsed = JSON.parse(rawBody) as Record<string, any>
    const data = (parsed.data ?? parsed) as Record<string, any>

    const providerOrderId = String(
      data.id ?? data.orderId ?? parsed.orderId ?? ''
    )
    const status = normalizeStatus(data.status as string | undefined)

    return {
      providerOrderId,
      status,
      txHash:
        (data.hash as string) ??
        (data.txHash as string) ??
        (data.cryptoTransactionId as string) ??
        undefined,
      cryptoAmount:
        Number(data.cryptoAmount ?? data.cryptoCurrencyAmount ?? 0) ||
        undefined,
      kycUrl: (data.kycUrl as string) ?? (data.kycLink as string) ?? undefined,
      reason:
        (data.statusReason as string) ??
        (data.failureReason as string) ??
        (data.message as string) ??
        undefined,
    }
  }
}
