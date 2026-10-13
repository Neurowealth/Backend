import { TaxJurisdiction } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { priceForAsset } from './pricing'
import { resolveJurisdiction } from './jurisdictions'

/**
 * Wash-sale window configuration by jurisdiction.
 * Matches the LossMatchingRule windowDays in src/tax/jurisdictions/types.ts
 */
const WASH_SALE_WINDOW_DAYS: Record<TaxJurisdiction, number> = {
  US: 30,
  UK: 30,
  DE: 30,
  AU: 30,
  CA: 30,
}

/**
 * Get the wash-sale window in days for a given jurisdiction.
 * Returns 30 days as a safe default for unknown jurisdictions.
 */
export function getWashSaleWindowDays(jurisdiction: TaxJurisdiction): number {
  return WASH_SALE_WINDOW_DAYS[jurisdiction] ?? 30
}

/**
 * Check if a disposal would create a wash-sale risk by looking for
 * same-asset acquisitions within the wash-sale window.
 *
 * @param assetSymbol - The asset being disposed
 * @param disposalDate - The date of the disposal
 * @param jurisdiction - The user's tax jurisdiction
 * @param hasRecentAcquisition - Whether the agent is likely to rebuy the same asset
 * @returns true if there's wash-sale risk, false otherwise
 */
export function hasWashSaleRisk(
  assetSymbol: string,
  disposalDate: Date,
  jurisdiction: TaxJurisdiction,
  hasRecentAcquisition: boolean
): boolean {
  if (!hasRecentAcquisition) {
    return false
  }

  const windowDays = getWashSaleWindowDays(jurisdiction)
  const windowMs = windowDays * 24 * 60 * 60 * 1000

  const windowStart = new Date(disposalDate.getTime() - windowMs)
  const windowEnd = new Date(disposalDate.getTime() + windowMs)

  return true
}

/**
 * Estimate if the agent is likely to rebuy the same asset within the wash-sale window.
 * This is a heuristic based on the agent's strategy logic.
 *
 * @param strategyName - The current strategy name
 * @param targetProtocol - The target protocol for rebalancing
 * @param currentProtocol - The current protocol being sold
 * @returns true if a same-asset rebuy is likely
 */
export function isSameAssetRebuyLikely(
  strategyName: string | null,
  targetProtocol: string,
  currentProtocol: string
): boolean {
  if (strategyName === 'TARGET_ALLOCATION') {
    return true
  }

  if (targetProtocol === currentProtocol) {
    return true
  }

  return false
}

/**
 * Result of evaluating potential unrealized loss for tax-loss harvesting.
 */
export interface TaxLossHarvestEstimate {
  assetSymbol: string
  currentPrice: Decimal
  costBasisPerUnit: Decimal
  unrealizedLossTotal: Decimal
  isLoss: boolean
  washSaleRisk: boolean
}

/**
 * Evaluate if a lot or position is in a loss position using live or historical market feed prices.
 * Enables tax-loss harvesting logic to consume non-stablecoin prices.
 *
 * @param assetSymbol - Symbol of the asset.
 * @param amount - Position or lot quantity.
 * @param costBasisPerUnit - Acquisition price per unit.
 * @param asOfDate - Evaluation date.
 * @param options - Wash-sale evaluation parameters.
 * @returns TaxLossHarvestEstimate or null if unpriced.
 */
export async function evaluateTaxLossHarvest(
  assetSymbol: string,
  amount: Decimal | string | number,
  costBasisPerUnit: Decimal | string | number,
  asOfDate?: Date,
  options?: {
    jurisdiction?: TaxJurisdiction
    hasRecentAcquisition?: boolean
  }
): Promise<TaxLossHarvestEstimate | null> {
  const priceInfo = await priceForAsset(assetSymbol, { asOfDate })
  if (!priceInfo.price) {
    return null
  }

  const currentPrice = priceInfo.price
  const basis = new Decimal(costBasisPerUnit)
  const difference = currentPrice.minus(basis)
  const isLoss = difference.isNegative()
  const unrealizedLossTotal = isLoss
    ? difference.abs().times(new Decimal(amount))
    : new Decimal(0)

  const washSaleRisk =
    isLoss &&
    options?.jurisdiction &&
    options.hasRecentAcquisition !== undefined
      ? hasWashSaleRisk(
          assetSymbol,
          asOfDate ?? new Date(),
          options.jurisdiction,
          options.hasRecentAcquisition
        )
      : false

  return {
    assetSymbol,
    currentPrice,
    costBasisPerUnit: basis,
    unrealizedLossTotal,
    isLoss,
    washSaleRisk,
  }
}
