/**
 * Fiat on-ramp / off-ramp provider abstraction (#290, extended #313).
 *
 * All provider-specific logic MUST live behind the {@link FiatRampProvider}
 * interface so a second vendor can be added without touching route handlers or
 * the reconciliation service. Nothing outside `src/fiat/providers/*` should
 * branch on the provider name.
 */

export type FiatDirection = 'ON_RAMP' | 'OFF_RAMP'

export interface QuoteRequest {
  direction: FiatDirection
  fiatAmount: number
  fiatCurrency: string
  assetSymbol: string
}

/**
 * Structured fee breakdown (#313). A provider that cannot itemize its fee MUST
 * leave the whole {@link QuoteResult.fees} field `null` (see `unpriced`) rather
 * than reporting zeros — a null fee is "we don't know", a zero fee is a claim.
 */
export interface FeeBreakdown {
  /** Provider's own commission, in fiatCurrency. */
  providerFee: number | null
  /** Estimated on-chain/network cost of settling the crypto leg, in fiatCurrency. */
  networkFee: number | null
  /** FX spread baked into the quoted rate vs. a reference mid-market rate, in fiatCurrency. */
  fxSpread: number | null
}

export interface QuoteResult {
  /** Provider key this quote came from (e.g. "moonpay"). */
  provider: string
  direction: FiatDirection
  fiatAmount: number
  fiatCurrency: string
  assetSymbol: string
  /** Estimated crypto amount the user receives (on-ramp) or must send (off-ramp). */
  cryptoAmount: number
  /** Provider fee expressed in fiatCurrency, when the provider reports it. Deprecated: prefer `fees`. */
  feeAmount?: number
  /** Exchange rate used (crypto units per 1 fiat unit), when reported. */
  rate?: number
  /**
   * Where the rate came from. Never assume 1.0 / same-currency: a provider
   * that quotes cross-currency without disclosing its source is a bug in that
   * provider adapter, not a default to fall back on here.
   */
  rateSource?: 'PROVIDER' | 'FX_FEED'
  /** Structured fee breakdown, or null when the provider cannot itemize fees. */
  fees: FeeBreakdown | null
  /** True when `fees` is null because the provider does not expose a breakdown. */
  unpriced: boolean
  /** True when the provider requires additional KYC for this currency/asset pair. */
  requiresKyc?: boolean
  /** Provider's own quote/session identifier, when it issues one. */
  providerQuoteId?: string
  /** When the provider stops honoring this quote, if it commits to a window. */
  expiresAt?: string
}

export interface CreateOrderRequest {
  userId: string
  direction: FiatDirection
  fiatAmount: number
  fiatCurrency: string
  assetSymbol: string
  /**
   * Destination Stellar address for an on-ramp (funds land here), or the
   * source custodial wallet for an off-ramp. The provider needs this to build
   * the hosted checkout / payout.
   */
  walletAddress: string
}

export interface CreateOrderResult {
  /** The provider's own order identifier — used as the idempotency key. */
  providerOrderId: string
  /** Hosted checkout URL the client redirects the user to (on-ramp). */
  checkoutUrl?: string
  /** KYC next-step URL when the provider blocks the order pending verification. */
  kycUrl?: string
  /** Initial provider-reported status, normalized. */
  status: NormalizedWebhookStatus
  /** Crypto amount quoted at creation time, if the provider commits to one. */
  cryptoAmount?: number
}

/**
 * Provider status callbacks are normalized into this closed set so the rest of
 * the system never depends on a provider's raw status strings.
 */
export type NormalizedWebhookStatus =
  'PENDING' | 'PROCESSING' | 'SETTLED' | 'FAILED' | 'REFUNDED' | 'KYC_REQUIRED'

export interface ParsedWebhook {
  providerOrderId: string
  status: NormalizedWebhookStatus
  /** On-chain tx hash the provider claims settled the crypto leg, if provided. */
  txHash?: string
  cryptoAmount?: number
  kycUrl?: string
  /** Human-readable reason for FAILED/REFUNDED, when the provider supplies one. */
  reason?: string
}

/**
 * A fiat ramp vendor. Implementations are the ONLY place that may contain
 * provider-specific request/response shapes or signature schemes.
 */
export interface FiatRampProvider {
  /** Stable key persisted on FiatOrder.provider (e.g. "moonpay"). */
  readonly name: string

  /** Fetch a buy/sell quote. */
  getQuote(req: QuoteRequest): Promise<QuoteResult>

  /** Initiate the provider flow, returning a hosted checkout URL when relevant. */
  createOrder(req: CreateOrderRequest): Promise<CreateOrderResult>

  /**
   * Verify the authenticity of a raw webhook request using the provider's own
   * signature scheme. MUST return false (never throw) on any verification
   * failure so callers can reject with no partial processing.
   *
   * @param rawBody The exact raw request body bytes as received.
   * @param headers Incoming request headers (lower-cased keys).
   */
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>
  ): boolean

  /** Parse a verified webhook body into the normalized shape. */
  parseWebhookPayload(rawBody: string): ParsedWebhook
}

// ── Multi-provider registry / best-execution types (#313) ─────────────────────

/**
 * Provider selection policy used to pick a provider when the caller doesn't
 * pin one via an explicit `provider` field or a locked `quoteId`:
 *
 *  - DEFAULT:            the configured FIAT_DEFAULT_PROVIDER, falling back to
 *                         any healthy provider if the default is unhealthy.
 *  - BEST_QUOTE:         run the best-execution quote flow and use whichever
 *                         provider came out on top.
 *  - ROUND_ROBIN_HEALTHY: rotate across currently-healthy providers.
 *  - PREFER_PROVIDER:    use a caller-supplied preferred provider when
 *                         healthy, otherwise fall back to DEFAULT semantics.
 */
export type ProviderSelectionPolicy =
  'DEFAULT' | 'BEST_QUOTE' | 'ROUND_ROBIN_HEALTHY' | 'PREFER_PROVIDER'

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface ProviderHealthSnapshot {
  provider: string
  state: CircuitState
  consecutiveFailures: number
  totalSuccess: number
  totalFailure: number
  lastFailureAt: string | null
  lastSuccessAt: string | null
  /** Convenience: state !== 'open'. */
  healthy: boolean
}

/** One provider's quote, ranked against its peers for a single request. */
export interface RankedQuote extends QuoteResult {
  /** Id of the persisted {@link FiatQuoteLock} row backing this quote. */
  quoteId: string
  /** ISO timestamp — order creation referencing this quoteId fails past this. */
  expiresAt: string
  /** 1 = best executable price among healthy providers that returned a quote. */
  rank: number
}

/** A provider that could not be quoted, with a structured reason. */
export interface ExcludedProviderQuote {
  provider: string
  reason: string
}

export interface BestExecutionQuoteResult {
  best: RankedQuote | null
  quotes: RankedQuote[]
  excluded: ExcludedProviderQuote[]
}

/** Thrown when no healthy provider could be queried for a quote/order. */
export class NoHealthyProvidersError extends Error {
  readonly code = 'no_healthy_providers'
  constructor(public readonly failures: ExcludedProviderQuote[]) {
    super('No healthy fiat providers are available')
    this.name = 'NoHealthyProvidersError'
  }
}

/**
 * Structured error surfaced to routes for quote-locking / order-creation
 * failures (#313). Lives here rather than in service.ts so it survives
 * `jest.mock('../fiat/service')` in route-level tests that stub the service
 * layer but still need `instanceof` checks on thrown errors to work.
 */
export class FiatOrderError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'FiatOrderError'
  }
}
