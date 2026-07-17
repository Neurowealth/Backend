/**
 * MoonPay fiat ramp provider (#290) — the one concrete implementation shipped
 * in v1. Everything MoonPay-specific (endpoints, request/response shapes, and
 * the webhook signature scheme) is contained here, behind FiatRampProvider.
 *
 * Webhook verification follows MoonPay's `Moonpay-Signature-V2` scheme: an
 * HMAC-SHA256 over `${timestamp}.${rawBody}` keyed by the webhook secret, with
 * the header formatted as `t=<unix-seconds>,s=<hex-signature>`. We compare with
 * a timing-safe equality check and never throw from verification.
 * https://dev.moonpay.com/docs/webhooks-verify-signature
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

const PROVIDER_NAME = 'moonpay'

/** Map MoonPay's raw transaction statuses onto our normalized set. */
function normalizeStatus(raw: string | undefined): NormalizedWebhookStatus {
  switch ((raw || '').toLowerCase()) {
    case 'completed':
      return 'SETTLED'
    case 'pending':
      return 'PROCESSING'
    case 'waitingpayment':
    case 'waitingauthorization':
      return 'PENDING'
    case 'failed':
      return 'FAILED'
    case 'refunded':
    case 'chargedback':
      return 'REFUNDED'
    default:
      return 'PENDING'
  }
}

/** Parse the `t=...,s=...` signature header into its parts. */
function parseSignatureHeader(header: string | undefined): { timestamp: string; signature: string } | null {
  if (!header) return null
  const parts = header.split(',').map((p) => p.trim())
  let timestamp = ''
  let signature = ''
  for (const part of parts) {
    const [k, v] = part.split('=')
    if (k === 't') timestamp = v
    if (k === 's') signature = v
  }
  if (!timestamp || !signature) return null
  return { timestamp, signature }
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

export class MoonPayProvider implements FiatRampProvider {
  readonly name = PROVIDER_NAME

  private readonly apiKey: string
  private readonly secretKey: string
  private readonly webhookKey: string
  private readonly baseUrl: string
  private readonly http: HttpClientAdapter

  constructor(opts?: { apiKey?: string; secretKey?: string; webhookKey?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.MOONPAY_API_KEY ?? ''
    this.secretKey = opts?.secretKey ?? process.env.MOONPAY_SECRET_KEY ?? ''
    this.webhookKey = opts?.webhookKey ?? process.env.MOONPAY_WEBHOOK_KEY ?? ''
    this.baseUrl = opts?.baseUrl ?? process.env.MOONPAY_API_BASE_URL ?? 'https://api.moonpay.com'
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
    const currencyCode = req.assetSymbol.toLowerCase()
    const baseCurrencyCode = req.fiatCurrency.toLowerCase()
    const amountParam = isBuy ? 'baseCurrencyAmount' : 'quoteCurrencyAmount'

    const url =
      `${this.baseUrl}/v3/currencies/${encodeURIComponent(currencyCode)}/${isBuy ? 'buy_quote' : 'sell_quote'}` +
      `?apiKey=${encodeURIComponent(this.apiKey)}` +
      `&baseCurrencyCode=${encodeURIComponent(baseCurrencyCode)}` +
      `&${amountParam}=${encodeURIComponent(String(req.fiatAmount))}`

    const data = await this.http.execute(async () => {
      const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
      if (!res.ok) {
        throw new Error(`MoonPay quote failed: HTTP ${res.status}`)
      }
      return (await res.json()) as Record<string, unknown>
    }, 'moonpay.getQuote')

    const cryptoAmount = Number(data.quoteCurrencyAmount ?? data.cryptoAmount ?? 0)
    const feeAmount = Number(data.feeAmount ?? 0) || undefined
    const rate = Number(data.exchangeRate ?? data.rate ?? 0) || undefined

    return {
      provider: this.name,
      direction: req.direction,
      fiatAmount: req.fiatAmount,
      fiatCurrency: req.fiatCurrency,
      assetSymbol: req.assetSymbol,
      cryptoAmount,
      feeAmount,
      rate,
    }
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResult> {
    // MoonPay's primary integration is a hosted widget; server-side we register
    // a transaction intent and hand back the hosted checkout URL. We POST the
    // intent and read the provider order id + status back.
    const isBuy = req.direction === 'ON_RAMP'
    const endpoint = `${this.baseUrl}/v3/transactions`

    const body = JSON.stringify({
      apiKey: this.apiKey,
      flow: isBuy ? 'buy' : 'sell',
      baseCurrencyCode: req.fiatCurrency.toLowerCase(),
      currencyCode: req.assetSymbol.toLowerCase(),
      baseCurrencyAmount: req.fiatAmount,
      walletAddress: req.walletAddress,
      externalCustomerId: req.userId,
    })

    const data = await this.http.execute(async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Api-Key ${this.secretKey}`,
        },
        body,
      })
      if (!res.ok) {
        throw new Error(`MoonPay createOrder failed: HTTP ${res.status}`)
      }
      return (await res.json()) as Record<string, unknown>
    }, 'moonpay.createOrder')

    const providerOrderId = String(data.id ?? '')
    if (!providerOrderId) {
      throw new Error('MoonPay createOrder returned no order id')
    }

    return {
      providerOrderId,
      checkoutUrl: (data.redirectUrl as string) ?? (data.widgetRedirectUrl as string) ?? undefined,
      kycUrl: (data.kycRedirectUrl as string) ?? undefined,
      status: normalizeStatus(data.status as string | undefined),
      cryptoAmount: Number(data.quoteCurrencyAmount ?? 0) || undefined,
    }
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string | undefined>): boolean {
    if (!this.webhookKey) {
      // No configured secret means we cannot verify — reject rather than trust.
      logger.error('[MoonPay] MOONPAY_WEBHOOK_KEY not configured — rejecting webhook')
      return false
    }

    const header =
      headers['moonpay-signature-v2'] ??
      headers['Moonpay-Signature-V2'] ??
      headers['x-moonpay-signature-v2']
    const parsed = parseSignatureHeader(header)
    if (!parsed) return false

    const signedPayload = `${parsed.timestamp}.${rawBody}`
    const expected = createHmac('sha256', this.webhookKey).update(signedPayload).digest('hex')

    return timingSafeEqualHex(expected, parsed.signature)
  }

  parseWebhookPayload(rawBody: string): ParsedWebhook {
    const parsed = JSON.parse(rawBody) as Record<string, any>
    // MoonPay wraps the resource under `data` with a top-level `type`.
    const data = (parsed.data ?? parsed) as Record<string, any>

    const providerOrderId = String(data.id ?? parsed.externalTransactionId ?? '')
    const status = normalizeStatus(data.status as string | undefined)

    return {
      providerOrderId,
      status: data.kycRedirectUrl && status !== 'SETTLED' ? 'KYC_REQUIRED' : status,
      txHash: (data.cryptoTransactionId as string) ?? (data.txHash as string) ?? undefined,
      cryptoAmount: Number(data.quoteCurrencyAmount ?? data.cryptoAmount ?? 0) || undefined,
      kycUrl: (data.kycRedirectUrl as string) ?? undefined,
      reason: (data.failureReason as string) ?? undefined,
    }
  }
}
