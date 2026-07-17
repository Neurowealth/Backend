/**
 * Fiat on-ramp / off-ramp provider abstraction (#290).
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

export interface QuoteResult {
  /** Provider key this quote came from (e.g. "moonpay"). */
  provider: string
  direction: FiatDirection
  fiatAmount: number
  fiatCurrency: string
  assetSymbol: string
  /** Estimated crypto amount the user receives (on-ramp) or must send (off-ramp). */
  cryptoAmount: number
  /** Provider fee expressed in fiatCurrency, when the provider reports it. */
  feeAmount?: number
  /** Exchange rate used (crypto units per 1 fiat unit), when reported. */
  rate?: number
  /** When the quote stops being valid, if the provider pins one. */
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
  | 'PENDING'
  | 'PROCESSING'
  | 'SETTLED'
  | 'FAILED'
  | 'REFUNDED'
  | 'KYC_REQUIRED'

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
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | undefined>): boolean

  /** Parse a verified webhook body into the normalized shape. */
  parseWebhookPayload(rawBody: string): ParsedWebhook
}
