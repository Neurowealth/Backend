/**
 * Pure facet-derivation over a strategy's live strategyConfig (#527). No DB,
 * no caching — facets must never drift from what the strategy actually does,
 * so they are computed fresh on every marketplace query rather than
 * materialized at publish time.
 */

export type RiskBand = 'conservative' | 'balanced' | 'aggressive'

export function deriveRiskBand(
  riskCeiling: number | null | undefined
): RiskBand {
  if (riskCeiling == null) return 'balanced'
  if (riskCeiling <= 30) return 'conservative'
  if (riskCeiling >= 70) return 'aggressive'
  return 'balanced'
}

export function deriveProtocolsTouched(
  targetAllocations: Record<string, number> | undefined
): string[] {
  if (!targetAllocations) return []
  return Object.keys(targetAllocations)
}
