/**
 * DB glue for the correlation / diversification endpoint (#348).
 *
 * Mirrors service.ts: this module reads the DB (ProtocolRate history for the
 * trailing window, and optionally the user's active position weights) and hands
 * the narrowed data to the pure core src/analytics/correlation.ts. No statistics
 * live here.
 */

import db from '../db'
import { RawRateObservation } from './types'
import { estimateCorrelation, CorrelationEstimationResult } from './correlation'

/** Optional query overrides for the correlation computation. */
export interface CorrelationOptions {
  lookbackDays?: number
  now?: Date
}

/**
 * Compute the correlation matrix + diversification score for all protocols with
 * rate history, weighting the score by the user's current portfolio when they
 * hold positions; otherwise equal-weight.
 */
export async function getPortfolioCorrelation(
  userId: string,
  options: CorrelationOptions = {}
): Promise<CorrelationEstimationResult> {
  const now = options.now ?? new Date()
  const lookbackDays = options.lookbackDays ?? 90

  const since = new Date(now.getTime() - lookbackDays * 86400_000)

  const [rateRows, holdings] = await Promise.all([
    db.protocolRate.findMany({
      where: { fetchedAt: { gte: since } },
      select: {
        protocolName: true,
        assetSymbol: true,
        supplyApy: true,
        fetchedAt: true,
      },
    }),
    db.position.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { protocolName: true, currentValue: true },
    }),
  ])

  const rates: RawRateObservation[] = rateRows.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    apy: Number(r.supplyApy),
    date: r.fetchedAt,
  }))

  const totalValue = holdings.reduce((s, p) => s + Number(p.currentValue), 0)
  let weights: Record<string, number> | undefined
  if (totalValue > 0) {
    weights = {}
    for (const h of holdings) {
      if (!h.protocolName) continue
      weights[h.protocolName] =
        (weights[h.protocolName] ?? 0) + Number(h.currentValue) / totalValue
    }
  }

  return estimateCorrelation({
    rates,
    lookbackDays,
    weights,
    now,
  })
}
