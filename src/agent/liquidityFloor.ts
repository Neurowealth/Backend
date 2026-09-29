/**
 * Agent-Enforced Liquidity Floor (#541).
 *
 * Enforces a standing instant-liquidity buffer configured by the user or strategy.
 *
 * Precedence Order:
 * 1. Liquidity Floor: evaluated FIRST before any yield or goal allocation.
 *    availableForYield = Math.max(0, totalBalance - liquidityFloor).
 *    If totalBalance <= liquidityFloor, ALL funds stay liquid (graceful degradation,
 *    surfaced as "your floor exceeds your balance; nothing is currently earning yield").
 * 2. Goals & Strategy Yield Allocation: evaluated on the remainder (availableForYield).
 *
 * Locked / Collateralized Positions:
 * Positions with isLocked === true, isCollateral === true, or status === 'LOCKED' / 'COLLATERAL'
 * NEVER count toward the liquidity floor regardless of asset liquidity class.
 *
 * Floor Restoration:
 * When currentLiquidBalance < liquidityFloor, the agent prioritizes unwinding positions
 * with the shortest time-to-exit first to restore the floor with minimal disruption.
 */

import { timeToFullExit, DepthCurvePoint } from '../analytics/liquidity'

export interface PositionLike {
  id?: string
  protocolName: string
  assetSymbol?: string
  currentValue?: string | number | { toString(): string; toNumber?(): number }
  amount?: string | number | { toString(): string; toNumber?(): number }
  isLocked?: boolean | null
  isCollateral?: boolean | null
  locked?: boolean | null
  collateral?: boolean | null
  status?: string | null
  metadata?: Record<string, unknown> | null
}

export interface ProtocolLiquiditySnapshotLike {
  protocolName: string
  assetSymbol?: string
  poolTvl?: number | string
  availableLiquidity?: number | string
  dailyVolume?: number | string
  withdrawalQueueDepth?: number | null
  depthCurve?: DepthCurvePoint[] | unknown
}

export interface ShortfallExit {
  positionId?: string
  protocolName: string
  assetSymbol?: string
  amountToUnwind: number
  timeToExitHours: number
}

export interface ShortfallExitPlan {
  shortfall: number
  restoredAmount: number
  remainingShortfall: number
  estimatedRestorationTimeHours: number
  exits: ShortfallExit[]
}

export type LiquidityFloorState =
  'SATISFIED' | 'SHORTFALL' | 'DEGRADED' | 'NO_FLOOR'

export interface LiquidityFloorStatus {
  floor: string
  totalBalance: string
  currentLiquidBalance: string
  shortfall: string
  availableForYield: string
  isSatisfied: boolean
  isDegraded: boolean
  status: LiquidityFloorState
  statusMessage: string
  estimatedRestorationTimeHours: number
  unwindPlan?: ShortfallExitPlan
}

/**
 * Known protocols that settle instantly with 0 withdrawal delay by default.
 */
export const INSTANT_LIQUIDITY_PROTOCOLS = new Set([
  'Cash',
  'Wallet',
  'Native',
  'Stellar DEX',
])

/**
 * Checks whether a position is locked or pledged as collateral.
 * Locked/collateralized positions must NOT count toward the liquidity floor.
 */
export function isPositionLocked(position: PositionLike): boolean {
  if (position.isLocked === true || position.isCollateral === true) return true
  if (position.locked === true || position.collateral === true) return true
  const statusUpper = position.status
    ? String(position.status).toUpperCase()
    : ''
  if (statusUpper === 'LOCKED' || statusUpper === 'COLLATERAL') return true
  if (
    position.metadata &&
    (position.metadata.isLocked === true ||
      position.metadata.isCollateral === true ||
      position.metadata.locked === true ||
      position.metadata.collateral === true)
  ) {
    return true
  }
  return false
}

/**
 * Resolves the numeric value of a position.
 */
export function getPositionValue(position: PositionLike): number {
  if (position.currentValue !== undefined && position.currentValue !== null) {
    if (typeof (position.currentValue as any).toNumber === 'function') {
      return (position.currentValue as any).toNumber()
    }
    const val = Number(position.currentValue.toString())
    if (!isNaN(val)) return val
  }
  if (position.amount !== undefined && position.amount !== null) {
    if (typeof (position.amount as any).toNumber === 'function') {
      return (position.amount as any).toNumber()
    }
    const val = Number(position.amount.toString())
    if (!isNaN(val)) return val
  }
  return 0
}

/**
 * Estimates the time in hours required to fully exit a position.
 * Returns Infinity if position is locked.
 * Returns 0 if instantly liquid.
 */
export function estimatePositionTimeToExit(
  position: PositionLike,
  snapshot?: ProtocolLiquiditySnapshotLike | null
): number {
  if (isPositionLocked(position)) {
    return Infinity
  }

  const valueUsd = getPositionValue(position)
  if (valueUsd <= 0) return 0

  if (snapshot) {
    const poolTvl = Number(snapshot.poolTvl ?? 0)
    const availableLiquidity = Number(snapshot.availableLiquidity ?? poolTvl)
    const maxExitPerSlice = Math.max(availableLiquidity * 0.1, 1)

    const calculated = timeToFullExit({
      positionValue: valueUsd,
      maxExitPerSlice,
      sliceIntervalHours: 1,
      depthRecoveryModel: 'linear',
    })

    if (calculated && typeof calculated.hours === 'number') {
      return calculated.hours
    }
  }

  if (INSTANT_LIQUIDITY_PROTOCOLS.has(position.protocolName)) {
    return 0
  }

  return 1
}

/**
 * Checks whether a position is currently instantly liquid (0 withdrawal delay and unlocked).
 */
export function isInstantLiquidPosition(
  position: PositionLike,
  snapshot?: ProtocolLiquiditySnapshotLike | null
): boolean {
  if (isPositionLocked(position)) return false
  const hours = estimatePositionTimeToExit(position, snapshot)
  return hours <= 0
}

/**
 * Sums the value of all active, unlocked, instantly-liquid positions.
 */
export function calculateLiquidBalance(
  positions: PositionLike[],
  snapshots?: Record<string, ProtocolLiquiditySnapshotLike>
): number {
  let liquidSum = 0
  for (const pos of positions) {
    const snap = snapshots ? snapshots[pos.protocolName] : undefined
    if (isInstantLiquidPosition(pos, snap)) {
      liquidSum += getPositionValue(pos)
    }
  }
  return liquidSum
}

/**
 * Evaluates the liquidity floor status against current positions.
 */
export function computeLiquidityFloorStatus(params: {
  floor: string | number | null | undefined
  positions: PositionLike[]
  snapshots?: Record<string, ProtocolLiquiditySnapshotLike>
}): LiquidityFloorStatus {
  const { floor, positions, snapshots } = params

  let totalBalance = 0
  for (const pos of positions) {
    totalBalance += getPositionValue(pos)
  }

  const currentLiquid = calculateLiquidBalance(positions, snapshots)

  const floorNum =
    floor !== null && floor !== undefined ? Math.max(0, Number(floor)) : 0
  const hasFloor = floorNum > 0 && !isNaN(floorNum)

  if (!hasFloor) {
    return {
      floor: '0',
      totalBalance: totalBalance.toString(),
      currentLiquidBalance: currentLiquid.toString(),
      shortfall: '0',
      availableForYield: totalBalance.toString(),
      isSatisfied: true,
      isDegraded: false,
      status: 'NO_FLOOR',
      statusMessage: 'No liquidity floor configured',
      estimatedRestorationTimeHours: 0,
    }
  }

  const shortfallNum = Math.max(0, floorNum - currentLiquid)
  const isDegraded = totalBalance <= floorNum
  const availableForYieldNum = isDegraded
    ? 0
    : Math.max(0, totalBalance - floorNum)

  let unwindPlan: ShortfallExitPlan | undefined
  let estimatedRestorationTimeHours = 0

  if (shortfallNum > 0) {
    unwindPlan = prioritizeShortfallExits(positions, shortfallNum, snapshots)
    estimatedRestorationTimeHours = unwindPlan.estimatedRestorationTimeHours
  }

  let status: LiquidityFloorState
  let statusMessage: string

  if (isDegraded) {
    status = 'DEGRADED'
    statusMessage =
      'your floor exceeds your balance; nothing is currently earning yield'
  } else if (shortfallNum > 0) {
    status = 'SHORTFALL'
    statusMessage = `Liquidity floor shortfall of $${shortfallNum.toFixed(2)}; unwinding positions`
  } else {
    status = 'SATISFIED'
    statusMessage = 'Standing liquidity floor satisfied'
  }

  return {
    floor: floorNum.toString(),
    totalBalance: totalBalance.toString(),
    currentLiquidBalance: currentLiquid.toString(),
    shortfall: shortfallNum.toString(),
    availableForYield: availableForYieldNum.toString(),
    isSatisfied: shortfallNum === 0,
    isDegraded,
    status,
    statusMessage,
    estimatedRestorationTimeHours,
    unwindPlan,
  }
}

/**
 * Prioritizes unwinding positions with the shortest time-to-exit first
 * to satisfy a liquidity shortfall while minimizing disruption.
 */
export function prioritizeShortfallExits(
  positions: PositionLike[],
  shortfall: number,
  snapshots?: Record<string, ProtocolLiquiditySnapshotLike>
): ShortfallExitPlan {
  if (shortfall <= 0) {
    return {
      shortfall: 0,
      restoredAmount: 0,
      remainingShortfall: 0,
      estimatedRestorationTimeHours: 0,
      exits: [],
    }
  }

  const candidates: Array<{
    pos: PositionLike
    value: number
    timeToExitHours: number
  }> = []

  for (const pos of positions) {
    if (isPositionLocked(pos)) continue
    const value = getPositionValue(pos)
    if (value <= 0) continue

    const snap = snapshots ? snapshots[pos.protocolName] : undefined
    const hours = estimatePositionTimeToExit(pos, snap)
    candidates.push({ pos, value, timeToExitHours: hours })
  }

  candidates.sort((a, b) => a.timeToExitHours - b.timeToExitHours)

  const exits: ShortfallExit[] = []
  let remainingShortfall = shortfall
  let maxTimeHours = 0

  for (const candidate of candidates) {
    if (remainingShortfall <= 0) break

    const unwindAmount = Math.min(candidate.value, remainingShortfall)
    exits.push({
      positionId: candidate.pos.id,
      protocolName: candidate.pos.protocolName,
      assetSymbol: candidate.pos.assetSymbol,
      amountToUnwind: unwindAmount,
      timeToExitHours: candidate.timeToExitHours,
    })

    if (candidate.timeToExitHours > maxTimeHours) {
      maxTimeHours = candidate.timeToExitHours
    }

    remainingShortfall -= unwindAmount
  }

  const restoredAmount = shortfall - remainingShortfall

  return {
    shortfall,
    restoredAmount,
    remainingShortfall: Math.max(0, remainingShortfall),
    estimatedRestorationTimeHours: maxTimeHours,
    exits,
  }
}

/**
 * Computes how much balance is available for strategy allocation under the liquidity floor.
 */
export function computeAvailableForYield(params: {
  totalBalance: number | string | bigint
  liquidityFloor?: number | string | bigint | null
}): {
  availableForYield: string
  isDegraded: boolean
} {
  const total = Number(params.totalBalance)
  const floor =
    params.liquidityFloor !== undefined && params.liquidityFloor !== null
      ? Number(params.liquidityFloor)
      : 0

  if (isNaN(floor) || floor <= 0) {
    return {
      availableForYield: total.toString(),
      isDegraded: false,
    }
  }

  if (total <= floor) {
    return {
      availableForYield: '0',
      isDegraded: true,
    }
  }

  const available = total - floor
  return {
    availableForYield: available.toString(),
    isDegraded: false,
  }
}
