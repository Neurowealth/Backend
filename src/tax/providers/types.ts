import { Decimal } from '@prisma/client/runtime/library'

export type PriceConfidence = 'HIGH' | 'LOW'

export type PriceGranularity =
  'DAILY_CLOSE' | 'HOURLY' | 'SPOT' | 'FALLBACK_NEAREST'

export interface PriceFeedResult {
  price: Decimal
  confidence: PriceConfidence
  granularity: PriceGranularity
  asOfDate: Date
  caveat: string | null
  sourceName: string
}

/**
 * Pluggable provider interface for non-stablecoin asset pricing.
 * Mirrors MailProvider and FiatRampProvider patterns across the platform.
 */
export interface PriceFeedProvider {
  readonly name: string

  /**
   * Resolve an asset price for a historical acquisition/disposal timestamp.
   *
   * @param assetSymbol - Asset ticker (e.g. XLM) or Stellar asset representation.
   * @param asOfDate - Target timestamp for historical pricing. If omitted, spot rate is queried.
   * @returns PriceFeedResult on success, or null if unpriceable / outage.
   */
  getPrice(
    assetSymbol: string,
    asOfDate?: Date
  ): Promise<PriceFeedResult | null>
}
