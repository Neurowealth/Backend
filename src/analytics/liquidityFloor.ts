import db from '../db'
import { STROOPS_PER_TOKEN } from '../config/financial-limits'
import {
  calculateLiquidityFloor,
  LIQUIDITY_CONFIG,
  maxExitWithinSlippage,
  planLiquidityFloorRestoration,
  timeToFullExit,
  type DepthCurvePoint,
  type LiquidityFloorPosition,
  type LiquidityFloorRestoration,
} from './liquidity'

const RESERVE_ASSET = 'USDC'

export interface LiquidityFloorStatus {
  floorUsd: number | null
  totalBalanceUsd: number
  liquidBalanceUsd: number
  availableForYieldUsd: number
  shortfallUsd: number
  estimatedRestoreHours: number | null
  dataAvailable: boolean
  floorExceedsBalance: boolean
  restorationPlan: LiquidityFloorRestoration[]
  instantProtocolNames: string[]
  instantProtocolCapacityUsd: Record<string, number>
  instantLiquidPositionIds: string[]
  lockedPositionIds: string[]
}

function parseDepthCurve(value: unknown): DepthCurvePoint[] | null {
  if (!Array.isArray(value)) return null
  const points: DepthCurvePoint[] = []
  for (const item of value) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('sizeUsd' in item) ||
      !('priceImpactBps' in item)
    ) {
      return null
    }
    const point = item as Record<string, unknown>
    if (
      typeof point.sizeUsd !== 'number' ||
      !Number.isFinite(point.sizeUsd) ||
      point.sizeUsd < 0 ||
      typeof point.priceImpactBps !== 'number' ||
      !Number.isFinite(point.priceImpactBps) ||
      point.priceImpactBps < 0
    ) {
      return null
    }
    points.push({
      sizeUsd: point.sizeUsd,
      priceImpactBps: point.priceImpactBps,
    })
  }
  return points
}

export async function getLiquidityFloorStatus(
  userId: string,
  now = new Date()
): Promise<LiquidityFloorStatus> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { liquidityFloor: true },
  })
  if (!user) throw new Error('User not found')

  const positions = await db.position.findMany({
    where: { userId, status: 'ACTIVE' },
    select: {
      id: true,
      protocolName: true,
      assetSymbol: true,
      currentValue: true,
      liquidityLocked: true,
      transactions: {
        where: { status: 'PENDING' },
        select: { id: true },
      },
    },
  })

  const reservePositions = positions.filter(
    (position) => position.assetSymbol.toUpperCase() === RESERVE_ASSET
  )
  const unsupportedAssetsPresent = positions.length !== reservePositions.length
  const cutoff = new Date(now.getTime() - LIQUIDITY_CONFIG.SNAPSHOT_MAX_AGE_MS)
  const snapshots = await db.protocolLiquiditySnapshot.findMany({
    where: {
      assetSymbol: RESERVE_ASSET,
      fetchedAt: { gte: cutoff },
    },
    orderBy: { fetchedAt: 'desc' },
  })

  const latestByProtocol = new Map<string, (typeof snapshots)[number]>()
  for (const snapshot of snapshots) {
    if (!latestByProtocol.has(snapshot.protocolName)) {
      latestByProtocol.set(snapshot.protocolName, snapshot)
    }
  }
  const instantProtocolCapacityUsd: Record<string, number> = {}
  for (const [protocolName, snapshot] of latestByProtocol.entries()) {
    const curve = parseDepthCurve(snapshot.depthCurve)
    const capacity =
      curve === null || !Number.isFinite(Number(snapshot.availableLiquidity))
        ? 0
        : maxExitWithinSlippage(
            curve,
            Number(snapshot.availableLiquidity),
            LIQUIDITY_CONFIG.TARGET_SLIPPAGE_BPS
          )
    if (
      curve !== null &&
      curve.length > 0 &&
      capacity > 0 &&
      snapshot.withdrawalQueueDepth === 0 &&
      snapshot.withdrawalDelayHours === 0
    ) {
      instantProtocolCapacityUsd[protocolName] = capacity
    }
  }
  const instantProtocolNames = Object.keys(instantProtocolCapacityUsd)

  let totalBalanceUsd = 0
  let liquidBalanceUsd = 0
  let dataAvailable = !unsupportedAssetsPresent
  const restorationPositions: LiquidityFloorPosition[] = []
  const instantLiquidPositionIds: string[] = []
  const lockedPositionIds: string[] = []

  for (const position of reservePositions) {
    if (position.liquidityLocked) lockedPositionIds.push(position.id)
    if ((position.transactions?.length ?? 0) > 0) {
      dataAvailable = false
      continue
    }
    const valueUsd = Number(position.currentValue) / STROOPS_PER_TOKEN
    if (!Number.isFinite(valueUsd) || valueUsd < 0) {
      dataAvailable = false
      continue
    }
    totalBalanceUsd += valueUsd

    const snapshot = latestByProtocol.get(position.protocolName)
    const depthCurve = snapshot ? parseDepthCurve(snapshot.depthCurve) : null
    if (
      !snapshot ||
      depthCurve === null ||
      !Number.isFinite(Number(snapshot.availableLiquidity)) ||
      Number(snapshot.availableLiquidity) <= 0 ||
      snapshot.withdrawalQueueDepth === null ||
      snapshot.withdrawalDelayHours === null
    ) {
      dataAvailable = false
      continue
    }

    const maxExit = maxExitWithinSlippage(
      depthCurve,
      Number(snapshot.availableLiquidity),
      LIQUIDITY_CONFIG.TARGET_SLIPPAGE_BPS
    )
    const instantlyLiquid =
      !position.liquidityLocked &&
      snapshot.withdrawalQueueDepth === 0 &&
      snapshot.withdrawalDelayHours === 0

    if (instantlyLiquid && maxExit >= valueUsd) {
      liquidBalanceUsd += valueUsd
      instantLiquidPositionIds.push(position.id)
      continue
    }

    const timeToExit =
      !position.liquidityLocked &&
      maxExit > 0 &&
      snapshot.withdrawalDelayHours > 0
        ? timeToFullExit({
            positionValue: valueUsd,
            maxExitPerSlice: maxExit,
            sliceIntervalHours:
              snapshot.withdrawalDelayHours *
              Math.max(1, snapshot.withdrawalQueueDepth + 1),
            depthRecoveryModel: 'linear',
          })
        : null
    restorationPositions.push({
      positionId: position.id,
      valueUsd:
        snapshot.withdrawalDelayHours === 0
          ? Math.min(valueUsd, maxExit)
          : valueUsd,
      timeToExitHours:
        snapshot.withdrawalDelayHours === 0 ? 0 : (timeToExit?.hours ?? null),
      locked: position.liquidityLocked,
    })
  }

  const floorUsd =
    user.liquidityFloor === null ? null : Number(user.liquidityFloor)
  const floor = floorUsd ?? 0
  const floorPlan = calculateLiquidityFloor({
    totalBalanceUsd,
    liquidBalanceUsd,
    floorUsd: floor,
  })
  const restorationPlan = planLiquidityFloorRestoration(
    restorationPositions,
    floorPlan.shortfallUsd
  )
  const plannedRestoreUsd = restorationPlan.reduce(
    (sum, item) => sum + item.amountUsd,
    0
  )
  const estimatedRestoreHours =
    floorPlan.shortfallUsd === 0
      ? 0
      : plannedRestoreUsd >= floorPlan.shortfallUsd
        ? restorationPlan.reduce((sum, item) => sum + item.timeToExitHours, 0)
        : null

  return {
    floorUsd,
    totalBalanceUsd,
    liquidBalanceUsd,
    availableForYieldUsd: dataAvailable ? floorPlan.availableForYieldUsd : 0,
    shortfallUsd: floorPlan.shortfallUsd,
    estimatedRestoreHours,
    dataAvailable,
    floorExceedsBalance: dataAvailable && floor > totalBalanceUsd,
    restorationPlan,
    instantProtocolNames,
    instantProtocolCapacityUsd,
    instantLiquidPositionIds,
    lockedPositionIds,
  }
}
