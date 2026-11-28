import { TaxJurisdiction } from '@prisma/client'
import { resolveJurisdiction } from './jurisdictions'
import { LossMatchingRule } from './jurisdictions/types'

/**
 * A jurisdiction's mechanical wash-sale rule (#788).
 *
 * Derived from the same `lossMatching` profile the tax report uses, so the
 * agent can never disagree with the report about whether a rule exists.
 * `null` means the jurisdiction has no such rule (DE and AU), which callers
 * must treat as "no risk" without doing any further work.
 */
export interface WashSaleWindow {
  kind: Exclude<LossMatchingRule['kind'], 'NONE'>
  windowDays: number
  windowMs: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function washSaleWindowFor(
  jurisdiction: TaxJurisdiction
): WashSaleWindow | null {
  const rule: LossMatchingRule = resolveJurisdiction(jurisdiction).lossMatching
  if (rule.kind === 'NONE' || rule.windowDays <= 0) {
    return null
  }
  return {
    kind: rule.kind,
    windowDays: rule.windowDays,
    windowMs: rule.windowDays * DAY_MS,
  }
}

/** @deprecated Use washSaleWindowFor, which returns null for NONE profiles. */
export function getWashSaleWindowDays(jurisdiction: TaxJurisdiction): number {
  return washSaleWindowFor(jurisdiction)?.windowDays ?? 0
}

export interface WashSaleRiskInput {
  assetSymbol: string
  disposalDate: Date
  jurisdiction: TaxJurisdiction
  /** True when the lots being disposed are at an unrealized loss. */
  isLoss: boolean
  /** Actual same-asset acquisition dates, before or after the disposal. */
  acquisitionDates: Date[]
}

/**
 * A wash-sale risk exists only when a jurisdiction actually has a loss-
 * matching rule, the disposal is at a loss, and there is a same-asset
 * acquisition inside [disposal - window, disposal + window] (#788).
 *
 * The previous implementation computed the window bounds and ignored them,
 * returning true for every "likely rebuy" heuristic hit, including gains and
 * jurisdictions with no rule.
 */
export function hasWashSaleRisk(input: WashSaleRiskInput): boolean {
  const window = washSaleWindowFor(input.jurisdiction)
  if (!window || !input.isLoss) {
    return false
  }

  const disposalMs = input.disposalDate.getTime()
  const windowStart = disposalMs - window.windowMs
  const windowEnd = disposalMs + window.windowMs

  return input.acquisitionDates.some((acquisition) => {
    const acquiredMs = acquisition.getTime()
    return acquiredMs >= windowStart && acquiredMs <= windowEnd
  })
}

/**
 * Estimate if the agent is likely to rebuy the same asset within the wash-sale
 * window. This is a heuristic based on the agent's strategy logic.
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
