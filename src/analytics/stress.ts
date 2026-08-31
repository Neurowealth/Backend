/**
 * Pure, zero-I/O scenario stress engine (#351).
 * Never imports src/stellar/*, db, or network. Deterministic given
 * {portfolio, scenario, asOf}.
 */

import type { StressScenario } from './scenarios'
import { STRESS_CAVEAT } from './scenarios'

export const STRESS_CAVEAT_EXPORT = STRESS_CAVEAT

interface PositionInput {
  protocol: string
  asset: string
  preValue: number
  apy?: number | null
  baseApy?: number | null
  incentiveApy?: number | null
}

export interface StressResult {
  preValueUsd: number
  postValueUsd: number
  impactUsd: number
  impactPct: number
  perPosition: Array<{
    protocol: string
    asset: string
    preValue: number
    postValue: number
    impactPct: number
    drivers: string[]
  }>
  modeledRecoveryDays: number | null
  permanentImpairment: boolean
  assumedIncentiveShare: boolean
  caveats: string[]
  asOf: string
}

const STABLECOIN_RE = /^(USDC|USDT|DAI|USD.*|STABLECOIN)$/i

function matchesAssetShock(asset: string, shockKey: string): boolean {
  const key = shockKey.trim()
  if (/^(USD_STABLECOIN|STABLECOIN)$/i.test(key))
    return STABLECOIN_RE.test(asset)
  if (/^XLM$/i.test(key)) return /^XLM$/i.test(asset)
  return asset.toLowerCase() === key.toLowerCase()
}

function resolveAssetShockPct(
  asset: string,
  map?: Record<string, number>
): number | null {
  if (!map) return null
  // exact match first (case-insensitive)
  for (const [k, v] of Object.entries(map)) {
    if (asset.toLowerCase() === k.toLowerCase()) return v
  }
  // class predicate
  for (const [k, v] of Object.entries(map)) {
    if (matchesAssetShock(asset, k)) return v
  }
  return null
}

function resolveApyShockPct(
  protocol: string,
  shock: number | Record<string, number> | undefined
): number {
  if (shock === undefined) return 0
  if (typeof shock === 'number') return shock
  for (const [k, v] of Object.entries(shock)) {
    if (protocol.toLowerCase() === k.toLowerCase()) return v
  }
  return 0
}

function resolveProtocolLoss(
  protocol: string,
  map?: Record<string, number>
): number {
  if (!map) return 0
  for (const [k, v] of Object.entries(map)) {
    if (protocol.toLowerCase() === k.toLowerCase()) return v
  }
  return 0
}

export function applyScenario(
  portfolio: { positions: PositionInput[] },
  scenario: StressScenario,
  asOf: Date = new Date()
): StressResult | null {
  const positions = portfolio.positions ?? []

  if (positions.length === 0) return null
  // degenerate: any non-positive preValue is treated as degenerate portfolio (no valid base)
  if (positions.every((p) => p.preValue <= 0)) return null

  const shocks = scenario.shocks ?? {}
  const recoveryDays = shocks.recoveryDays ?? 90

  let preValueUsd = 0
  let postValueUsd = 0
  const perPosition: StressResult['perPosition'] = []
  let assumedIncentiveShare = false
  const caveats: string[] = [STRESS_CAVEAT]

  // For recovery calc: weighted post yield
  let apyNumerator = 0

  for (const pos of positions) {
    const preValue = Number(pos.preValue)
    if (!Number.isFinite(preValue) || preValue < 0) continue
    preValueUsd += preValue

    let curValue = preValue
    const drivers: string[] = []

    // 1) protocol loss (principal haircut)
    const lossPct = resolveProtocolLoss(pos.protocol, shocks.protocolLossPct)
    if (lossPct) {
      curValue *= 1 - lossPct / 100
      drivers.push(`protocolLoss:${lossPct}%`)
    }

    // 2) price shock
    const priceShock = resolveAssetShockPct(
      pos.asset,
      shocks.assetPriceShockPct
    )
    if (priceShock !== null && priceShock !== 0) {
      curValue *= 1 + priceShock / 100
      drivers.push(`price:${priceShock}%`)
    }

    // drivers for yield shocks are tracked but don't change immediate postValue (forward yield)

    postValueUsd += curValue

    // post yield for recovery
    let apy = pos.apy ?? 0
    const baseApy = pos.baseApy
    const incentiveApy = pos.incentiveApy

    if (shocks.incentiveApyToZero) {
      if (incentiveApy != null && Number.isFinite(incentiveApy)) {
        apy = baseApy ?? 0
        drivers.push('incentiveToZero')
      } else if ((pos.apy ?? 0) > 0) {
        // fallback flat 15% share assumption
        const assumed = 0.15
        apy = pos.apy! * (1 - assumed)
        assumedIncentiveShare = true
        drivers.push('incentiveToZero:assumed15%')
      }
    }

    const apyShock = resolveApyShockPct(pos.protocol, shocks.apyShockPct)
    if (apyShock) {
      const before = apy
      apy = apy * (1 + apyShock / 100)
      if (apy < 0) apy = 0
      drivers.push(`apy:${apyShock}%:${before.toFixed(2)}->${apy.toFixed(2)}`)
    }

    apyNumerator += curValue * apy

    perPosition.push({
      protocol: pos.protocol,
      asset: pos.asset,
      preValue,
      postValue: curValue,
      impactPct: preValue > 0 ? ((curValue - preValue) / preValue) * 100 : 0,
      drivers,
    })
  }

  if (preValueUsd <= 0) return null

  const impactUsd = postValueUsd - preValueUsd
  const impactPct = (impactUsd / preValueUsd) * 100

  // recovery: linear path at post-shock yield
  const postYieldPct = postValueUsd > 0 ? apyNumerator / postValueUsd : 0
  let modeledRecoveryDays: number | null = null
  let permanentImpairment = false

  if (impactUsd < 0) {
    const deficit = -impactUsd
    if (postYieldPct <= 0) {
      permanentImpairment = true
      modeledRecoveryDays = null
    } else {
      const dailyYield = (postValueUsd * (postYieldPct / 100)) / 365
      if (dailyYield <= 0) {
        permanentImpairment = true
      } else {
        const rawDays = deficit / dailyYield
        // capped by scenario recoveryDays * 4 as sanity, but allow null if never
        modeledRecoveryDays = Math.ceil(rawDays)
        if (modeledRecoveryDays > recoveryDays * 4) {
          // linear recovery assumption flagged as long
          caveats.push(
            `Modeled recovery ${modeledRecoveryDays}d exceeds scenario window ${recoveryDays}d`
          )
        }
      }
    }
  } else {
    modeledRecoveryDays = 0
  }

  if (assumedIncentiveShare) {
    caveats.push(
      'Assumed 15% incentive share for incentiveApyToZero fallback; no decomposition available'
    )
  }

  return {
    preValueUsd,
    postValueUsd,
    impactUsd,
    impactPct,
    perPosition,
    modeledRecoveryDays,
    permanentImpairment,
    assumedIncentiveShare,
    caveats,
    asOf: asOf.toISOString(),
  }
}
