/**
 * USD pricing for tax lots (#284, extended by #317 and #444).
 *
 * Source hierarchy, checked in order:
 *   1. An explicit user-declared price (e.g. supplied at deposit time for an
 *      asset the platform doesn't otherwise price) — USER_DECLARED.
 *   2. A market-data feed lookup for volatile assets — MARKET_FEED (#444).
 *      Backed by Horizon orderbook, Stellar Expert, or HTTP oracle with TTL
 *      caching and honest null fallback.
 *   3. The USDC 1:1 USD assumption — STABLECOIN_ASSUMPTION (unchanged).
 *   4. null = genuinely unpriced, surfaced with a caveat — never a silent
 *      zero (unchanged contract).
 *
 * Prices are per token; amounts must be token units (see
 * docs/TAX_REPORT.md "Units").
 */
import { PriceSource } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import {
  fetchPriceFromFeed,
  getCachedPriceSync,
  getQuoteMetadata,
  clearPriceFeedCache,
  setPriceFeedAdapter,
  resetPriceFeedAdapter,
} from './feedAdapter'

export {
  PriceSource,
  getQuoteMetadata,
  clearPriceFeedCache,
  setPriceFeedAdapter,
  resetPriceFeedAdapter,
}

export interface AssetPrice {
  price: Decimal | null
  source: PriceSource | null
}

export interface PriceForAssetOptions {
  userDeclaredPrice?: Decimal | string | number
}

/**
 * Look up the market price for a volatile asset using the configured
 * price-feed adapter and TTL cache. Returns null on miss or outage.
 * Never returns a fabricated value or silent zero.
 *
 * @param assetSymbol Asset ticker symbol or CODE:ISSUER
 * @returns Verified Decimal price or null
 */
export async function lookupFeedPrice(
  assetSymbol: string
): Promise<Decimal | null> {
  if (assetSymbol.trim().toUpperCase() === 'USDC') {
    return null
  }
  return fetchPriceFromFeed(assetSymbol)
}

/**
 * Synchronous lookup from in-memory cache for pre-warmed quotes.
 *
 * @param assetSymbol Asset ticker symbol or CODE:ISSUER
 * @returns Cached Decimal price or null
 */
export function lookupFeedPriceSync(assetSymbol: string): Decimal | null {
  if (assetSymbol.trim().toUpperCase() === 'USDC') {
    return null
  }
  return getCachedPriceSync(assetSymbol)
}

/**
 * Resolves the price and source classification for an asset following the
 * 4-level hierarchy:
 * 1. Explicit userDeclaredPrice -> USER_DECLARED
 * 2. Market feed quote (cached / fetched) -> MARKET_FEED
 * 3. USDC stablecoin assumption 1:1 -> STABLECOIN_ASSUMPTION
 * 4. Unpriced -> null
 *
 * @param assetSymbol Asset ticker symbol or CODE:ISSUER
 * @param options Optional overrides such as userDeclaredPrice
 * @returns AssetPrice with price and source, or nulls
 */
export async function priceForAsset(
  assetSymbol: string,
  options?: PriceForAssetOptions
): Promise<AssetPrice> {
  if (options?.userDeclaredPrice !== undefined) {
    return {
      price: new Decimal(options.userDeclaredPrice),
      source: PriceSource.USER_DECLARED,
    }
  }

  const feedPrice = await lookupFeedPrice(assetSymbol)
  if (feedPrice !== null) {
    return { price: feedPrice, source: PriceSource.MARKET_FEED }
  }

  if (assetSymbol.trim().toUpperCase() === 'USDC') {
    return { price: new Decimal(1), source: PriceSource.STABLECOIN_ASSUMPTION }
  }

  return { price: null, source: null }
}

/**
 * Synchronous variant of priceForAsset using in-memory cache.
 *
 * @param assetSymbol Asset ticker symbol or CODE:ISSUER
 * @param options Optional overrides such as userDeclaredPrice
 * @returns AssetPrice with price and source, or nulls
 */
export function priceForAssetSync(
  assetSymbol: string,
  options?: PriceForAssetOptions
): AssetPrice {
  if (options?.userDeclaredPrice !== undefined) {
    return {
      price: new Decimal(options.userDeclaredPrice),
      source: PriceSource.USER_DECLARED,
    }
  }

  const feedPrice = lookupFeedPriceSync(assetSymbol)
  if (feedPrice !== null) {
    return { price: feedPrice, source: PriceSource.MARKET_FEED }
  }

  if (assetSymbol.trim().toUpperCase() === 'USDC') {
    return { price: new Decimal(1), source: PriceSource.STABLECOIN_ASSUMPTION }
  }

  return { price: null, source: null }
}
