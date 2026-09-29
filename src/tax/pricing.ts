/**
 * USD pricing for tax lots (#284, extended by #317 and #525).
 *
 * Source hierarchy, checked in order:
 *   1. An explicit user-declared price (e.g. supplied at deposit time for an
 *      asset the platform doesn't otherwise price) — USER_DECLARED.
 *   2. A market-data feed lookup for volatile assets — MARKET_FEED.
 *      Queries pluggable PriceFeedProvider (e.g. StellarDexPriceFeedProvider via Horizon
 *      trade aggregations or path-finding) with bounded-TTL caching.
 *   3. The USDC 1:1 USD assumption — STABLECOIN_ASSUMPTION.
 *   4. null = genuinely unpriced, surfaced with a caveat — never a silent zero.
 *
 * Prices are per token; amounts must be token units (see docs/TAX_REPORT.md "Units").
 */
import { PriceSource } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import {
  defaultPriceCache,
  getPriceFeedProvider,
  PriceConfidence,
  PriceFeedProvider,
  PriceFeedResult,
  PriceGranularity,
} from './providers'

export { PriceConfidence, PriceGranularity, PriceFeedResult, PriceFeedProvider }

export interface AssetPrice {
  price: Decimal | null
  source: PriceSource | null
  confidence?: PriceConfidence | null
  granularity?: PriceGranularity | null
  caveat?: string | null
  asOfDate?: Date | null
}

export interface PriceForAssetOptions {
  userDeclaredPrice?: Decimal | string | number
  asOfDate?: Date
  provider?: PriceFeedProvider
  bypassCache?: boolean
}

/**
 * Resolve price from active market data feed provider with bounded caching.
 * Degrades safely to null on provider outages, missing dates, or thin markets.
 *
 * @param assetSymbol - Symbol or Stellar identifier of the asset.
 * @param asOfDate - Historical transaction timestamp.
 * @param provider - Explicit PriceFeedProvider instance, defaulting to configured provider.
 * @param bypassCache - Flag to bypass the memory cache.
 * @returns Resolved PriceFeedResult or null.
 */
export async function lookupFeedPrice(
  assetSymbol: string,
  asOfDate?: Date,
  provider?: PriceFeedProvider,
  bypassCache: boolean = false
): Promise<PriceFeedResult | null> {
  const upperSymbol = assetSymbol.trim().toUpperCase()

  if (!bypassCache) {
    const cached = defaultPriceCache.get(upperSymbol, asOfDate)
    if (cached) {
      return cached
    }
  }

  const activeProvider = provider ?? getPriceFeedProvider()

  try {
    const result = await activeProvider.getPrice(upperSymbol, asOfDate)
    if (result) {
      defaultPriceCache.set(upperSymbol, result, asOfDate)
      return result
    }
    return null
  } catch {
    return null
  }
}

/**
 * Determine asset price and pricing source following the strict resolution hierarchy.
 *
 * @param assetSymbol - Symbol of the asset to price.
 * @param options - Resolution options including user declared prices, historical date, and provider override.
 * @returns AssetPrice containing price, source, and confidence metadata.
 */
export async function priceForAsset(
  assetSymbol: string,
  options?: PriceForAssetOptions
): Promise<AssetPrice> {
  const upperSymbol = assetSymbol.trim().toUpperCase()

  if (options?.userDeclaredPrice !== undefined) {
    return {
      price: new Decimal(options.userDeclaredPrice),
      source: PriceSource.USER_DECLARED,
      confidence: 'HIGH',
      granularity: 'SPOT',
      asOfDate: options.asOfDate ?? new Date(),
      caveat: null,
    }
  }

  const feedResult = await lookupFeedPrice(
    upperSymbol,
    options?.asOfDate,
    options?.provider,
    options?.bypassCache
  )

  if (feedResult !== null) {
    return {
      price: feedResult.price,
      source: PriceSource.MARKET_FEED,
      confidence: feedResult.confidence,
      granularity: feedResult.granularity,
      caveat: feedResult.caveat,
      asOfDate: feedResult.asOfDate,
    }
  }

  if (upperSymbol === 'USDC') {
    return {
      price: new Decimal(1),
      source: PriceSource.STABLECOIN_ASSUMPTION,
      confidence: 'HIGH',
      granularity: options?.asOfDate ? 'DAILY_CLOSE' : 'SPOT',
      asOfDate: options?.asOfDate ?? new Date(),
      caveat: null,
    }
  }

  return {
    price: null,
    source: null,
    confidence: null,
    granularity: null,
    caveat: options?.asOfDate
      ? 'Historical price unavailable from market feed for transaction timestamp'
      : 'Asset unsupported by market feed',
    asOfDate: options?.asOfDate ?? null,
  }
}
