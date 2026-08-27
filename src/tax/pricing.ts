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

export interface AssetPrice {
  price: Decimal | null
  source: PriceSource | null
}

export interface PriceForAssetOptions {
  userDeclaredPrice?: Decimal | string | number
}

/**
 * Integration point for a future market-data source (the same "fetched and
 * stored" shape as ProtocolRate — see prisma/schema.prisma). Always returns
 * null today: no feed/credentials exist yet, and priceForAsset's contract
 * requires unpriced assets to stay honestly null, never a fabricated value.
 */
function lookupFeedPrice(_assetSymbol: string): Decimal | null {
  return null
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
