/**
 * DB glue for the yield-breakdown endpoint (#349).
 *
 * Mirrors correlationService.ts / service.ts: reads the DB (latest ProtocolRate
 * per protocol, optionally narrowed to the protocols a user holds) and hands the
 * narrowed rows to the pure core src/analytics/yieldComposition.ts. No
 * arithmetic lives here.
 */

import db from '../db'
import {
  effectiveApy,
  incentiveShare,
  shouldUseEffectiveApy,
  YIELD_CAVEAT,
} from './yieldComposition'

interface RawRateRow {
  protocolName: string
  assetSymbol: string
  network: string
  supplyApy: number
  baseApy: number | null
  incentiveApy: number | null
  rewardTokens: unknown
  fetchedAt: Date
}

function toNumber(v: { toNumber(): number } | unknown): number | null {
  if (v === null || v === undefined) return null
  return Number(v)
}

/**
 * Fetch the latest rate row per (protocol, asset, network).
 */
async function loadLatestRates(protocols?: string[]): Promise<RawRateRow[]> {
  const where =
    protocols && protocols.length > 0 ? { protocolName: { in: protocols } } : {}
  const rows = await db.protocolRate.findMany({
    where,
    orderBy: { fetchedAt: 'desc' },
    distinct: ['protocolName', 'assetSymbol', 'network'],
    select: {
      protocolName: true,
      assetSymbol: true,
      network: true,
      supplyApy: true,
      baseApy: true,
      incentiveApy: true,
      rewardTokens: true,
      fetchedAt: true,
    },
  })
  return rows.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    network: r.network,
    supplyApy: Number(r.supplyApy),
    baseApy: toNumber(r.baseApy),
    incentiveApy: toNumber(r.incentiveApy),
    rewardTokens: r.rewardTokens,
    fetchedAt: r.fetchedAt,
  }))
}

export interface YieldBreakdownResult {
  protocols: Array<{
    protocol: string
    asset: string
    network: string
    supplyApy: number
    baseApy: number | null
    incentiveApy: number | null
    rewardTokens: unknown
    incentiveShare: number | null
    effectiveApy: number
  }>
  effectiveApyEnabled: boolean
  caveat: string
}

/**
 * Compute the yield breakdown for the protocols a user actively holds; when the
 * user holds none, fall back to every protocol with a latest rate.
 */
export async function getYieldBreakdown(
  userId: string
): Promise<YieldBreakdownResult> {
  const held = await db.position.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { protocolName: true },
  })
  const heldProtocols = Array.from(
    new Set(held.map((p) => p.protocolName).filter((p): p is string => !!p))
  )

  const rows = await loadLatestRates(
    heldProtocols.length > 0 ? heldProtocols : undefined
  )

  const enabled = shouldUseEffectiveApy()

  const protocols = rows.map((r) => {
    const share = incentiveShare(r.baseApy, r.incentiveApy)
    const eff = effectiveApy({
      baseApy: r.baseApy,
      incentiveApy: r.incentiveApy,
      supplyApy: r.supplyApy,
    })
    return {
      protocol: r.protocolName,
      asset: r.assetSymbol,
      network: r.network,
      supplyApy: r.supplyApy,
      baseApy: r.baseApy,
      incentiveApy: r.incentiveApy,
      rewardTokens: r.rewardTokens,
      incentiveShare: share,
      effectiveApy: eff ?? r.supplyApy,
    }
  })

  return {
    protocols,
    effectiveApyEnabled: enabled,
    caveat: YIELD_CAVEAT,
  }
}
