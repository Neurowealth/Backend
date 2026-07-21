/**
 * USD pricing for tax lots (#284). v1 prices stablecoins only: USDC is
 * assumed 1:1 USD with an explicit STABLECOIN_ASSUMPTION source surfaced in
 * the report. Any other asset returns a null price, is flagged per-lot and
 * per-disposal, and is excluded from report totals with a visible caveat —
 * never silently zeroed. Prices are per token; amounts must be token units
 * (see docs/TAX_REPORT.md "Units").
 */
import { PriceSource } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

export interface AssetPrice {
  price: Decimal | null
  source: PriceSource | null
}

export function priceForAsset(assetSymbol: string): AssetPrice {
  if (assetSymbol === 'USDC') {
    return { price: new Decimal(1), source: PriceSource.STABLECOIN_ASSUMPTION }
  }
  return { price: null, source: null }
}
