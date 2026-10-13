/**
 * USD pricing for tax lots (#284, extended by #317).
 *
 * Source hierarchy, checked in order:
 *   1. An explicit user-declared price (e.g. supplied at deposit time for an
 *      asset the platform doesn't otherwise price) — USER_DECLARED.
 *   2. A market-data feed lookup for volatile assets — STUBBED (see
 *      lookupFeedPrice below). No feed is wired up in this v1; the function
 *      always returns null so this hierarchy level is a real, tested
 *      integration point rather than a TODO comment.
 *   3. The USDC 1:1 USD assumption — STABLECOIN_ASSUMPTION (unchanged).
 *   4. null = genuinely unpriced, surfaced with a caveat — never a silent
 *      zero (unchanged contract).
 *
 * Prices are per token; amounts must be token units (see
 * docs/TAX_REPORT.md "Units").
 */
import { PriceSource } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { getCachedStablecoinPrice } from '../stellar/priceFeed'

export interface AssetPrice {
  price: Decimal | null
  source: PriceSource | null
}

export interface PriceForAssetOptions {
  userDeclaredPrice?: Decimal | string | number
}

/**
 * Market-data source lookup wired to the shared priceFeed module.
 * Returns the cached spot price if available, or null when no fresh feed is available.
 */
function lookupFeedPrice(assetSymbol: string): Decimal | null {
  const cached = getCachedStablecoinPrice(assetSymbol)
  return cached !== null && Number.isFinite(cached) && cached > 0
    ? new Decimal(cached)
    : null
}

export function priceForAsset(
  assetSymbol: string,
  options?: PriceForAssetOptions
): AssetPrice {
  if (options?.userDeclaredPrice !== undefined) {
    return {
      price: new Decimal(options.userDeclaredPrice),
      source: PriceSource.USER_DECLARED,
    }
  }

  const feedPrice = lookupFeedPrice(assetSymbol)
  if (feedPrice !== null) {
    return { price: feedPrice, source: PriceSource.MARKET_FEED }
  }

  if (assetSymbol === 'USDC') {
    return { price: new Decimal(1), source: PriceSource.STABLECOIN_ASSUMPTION }
  }

  return { price: null, source: null }
}
