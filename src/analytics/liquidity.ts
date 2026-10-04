/**
 * src/analytics/liquidity.ts
 *
 * Liquidity risk and time-to-exit estimation.
 * Minimal implementation for #350.
 */

// ── Configuration ───────────────────────────────────────────────────────────────

const LIQ_TARGET_SLIPPAGE_BPS = 50 // 0.5%
const LIQ_TARGET_EXIT_DAYS = 7
const LIQ_SNAPSHOT_MAX_AGE_MS = 86_400_000 // 24 hours

// ── Types ───────────────────────────────────────────────────────────────────────

export interface DepthCurvePoint {
  sizeUsd: number
  priceImpactBps: number
}

export interface LiquidityMetrics {
  exitableNowWithinTarget: number
  exitableNowPct: number
  timeToFullExit: number | null
  liquidityScore: number | null
  dataAvailable: boolean
  bindingConstraint?: 'depth' | 'cooldown' | 'none'
}

export interface LiquidityFloorPosition {
  positionId: string
  valueUsd: number
  timeToExitHours: number | null
  locked: boolean
}

export interface LiquidityFloorRestoration {
  positionId: string
  amountUsd: number
  timeToExitHours: number
}

export function calculateLiquidityFloor(params: {
  totalBalanceUsd: number
  liquidBalanceUsd: number
  floorUsd: number
}): {
  availableForYieldUsd: number
  shortfallUsd: number
} {
  const { totalBalanceUsd, liquidBalanceUsd, floorUsd } = params
  if (
    !Number.isFinite(totalBalanceUsd) ||
    !Number.isFinite(liquidBalanceUsd) ||
    !Number.isFinite(floorUsd) ||
    totalBalanceUsd < 0 ||
    liquidBalanceUsd < 0 ||
    floorUsd < 0
  ) {
    return { availableForYieldUsd: 0, shortfallUsd: 0 }
  }

  return {
    availableForYieldUsd: Math.max(0, totalBalanceUsd - floorUsd),
    shortfallUsd: Math.max(0, floorUsd - liquidBalanceUsd),
  }
}

export function planLiquidityFloorRestoration(
  positions: LiquidityFloorPosition[],
  shortfallUsd: number
): LiquidityFloorRestoration[] {
  if (!Number.isFinite(shortfallUsd) || shortfallUsd <= 0) return []

  const candidates = positions
    .filter(
      (position) =>
        !position.locked &&
        Number.isFinite(position.valueUsd) &&
        position.valueUsd > 0 &&
        position.timeToExitHours !== null &&
        Number.isFinite(position.timeToExitHours) &&
        position.timeToExitHours >= 0
    )
    .sort(
      (a, b) =>
        a.timeToExitHours! - b.timeToExitHours! ||
        a.positionId.localeCompare(b.positionId)
    )

  let remaining = shortfallUsd
  const restoration: LiquidityFloorRestoration[] = []
  for (const position of candidates) {
    if (remaining <= 0) break
    const amountUsd = Math.min(position.valueUsd, remaining)
    restoration.push({
      positionId: position.positionId,
      amountUsd,
      timeToExitHours: position.timeToExitHours!,
    })
    remaining -= amountUsd
  }

  return restoration
}

// ── Pure Core Functions ────────────────────────────────────────────────────────

export function maxExitWithinSlippage(
  depthCurve: DepthCurvePoint[],
  availableLiquidity: number,
  targetSlippageBps: number
): number {
  if (depthCurve.length === 0) return 0

  // Find the largest size where price impact is at or below target
  let maxSize = 0
  for (const point of depthCurve) {
    if (point.priceImpactBps <= targetSlippageBps) {
      maxSize = Math.max(maxSize, point.sizeUsd)
    }
  }

  return Math.min(maxSize, availableLiquidity)
}

export function timeToFullExit(params: {
  positionValue: number
  maxExitPerSlice: number
  sliceIntervalHours: number
  depthRecoveryModel: 'linear'
}): { hours: number; slices: number; worstSliceImpactBps: number } | null {
  const { positionValue, maxExitPerSlice, sliceIntervalHours } = params

  if (maxExitPerSlice <= 0) return null

  const slices = Math.ceil(positionValue / maxExitPerSlice)
  const hours = slices * sliceIntervalHours

  // Simplified - would model actual depth recovery
  const worstSliceImpactBps = 0

  return { hours, slices, worstSliceImpactBps }
}

export function liquidityScore(
  positionValue: number,
  exitableNow: number,
  timeToFullExitHours: number | null
): number | null {
  if (positionValue <= 0) return null

  const exitablePct = (exitableNow / positionValue) * 100

  // Time penalty: more points for faster exits
  let timeScore = 100
  if (timeToFullExitHours !== null) {
    const targetHours = LIQ_TARGET_EXIT_DAYS * 24
    if (timeToFullExitHours > targetHours) {
      timeScore = Math.max(
        0,
        100 - ((timeToFullExitHours - targetHours) / targetHours) * 50
      )
    }
  }

  // Blend exitable percentage and time score
  return Math.round(exitablePct * 0.6 + timeScore * 0.4)
}

// ── Exported Configuration ─────────────────────────────────────────────────────

export const LIQUIDITY_CONFIG = {
  TARGET_SLIPPAGE_BPS: LIQ_TARGET_SLIPPAGE_BPS,
  TARGET_EXIT_DAYS: LIQ_TARGET_EXIT_DAYS,
  SNAPSHOT_MAX_AGE_MS: LIQ_SNAPSHOT_MAX_AGE_MS,
}
