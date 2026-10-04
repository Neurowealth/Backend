import { Prisma } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { LIQUIDITY_CONFIG, type DepthCurvePoint } from './liquidity'

export interface ProtocolLiquiditySnapshotInput {
  protocolName: string
  assetSymbol: string
  poolTvl: number
  availableLiquidity: number
  dailyVolume: number
  withdrawalQueueDepth: number | null
  withdrawalDelayHours: number | null
  depthCurve: DepthCurvePoint[]
}

function parseProviderNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function buildExplicitProtocolLiquiditySnapshot(
  protocolName: string,
  assetSymbol: string,
  source: unknown
): ProtocolLiquiditySnapshotInput | null {
  if (typeof source !== 'object' || source === null) return null
  const data = source as Record<string, unknown>
  const availableLiquidity = parseProviderNumber(data.availableLiquidity)
  const withdrawalQueueDepth = parseProviderNumber(data.withdrawalQueueDepth)
  const withdrawalDelayHours = parseProviderNumber(data.withdrawalDelayHours)
  if (
    availableLiquidity === null ||
    availableLiquidity <= 0 ||
    withdrawalQueueDepth === null ||
    !Number.isInteger(withdrawalQueueDepth) ||
    withdrawalQueueDepth < 0 ||
    withdrawalDelayHours === null ||
    !Number.isInteger(withdrawalDelayHours) ||
    withdrawalDelayHours < 0 ||
    !Array.isArray(data.depthCurve)
  ) {
    return null
  }

  const depthCurve: DepthCurvePoint[] = []
  for (const point of data.depthCurve) {
    if (typeof point !== 'object' || point === null) return null
    const sizeUsd = parseProviderNumber(
      (point as Record<string, unknown>).sizeUsd
    )
    const priceImpactBps = parseProviderNumber(
      (point as Record<string, unknown>).priceImpactBps
    )
    if (
      sizeUsd === null ||
      sizeUsd < 0 ||
      priceImpactBps === null ||
      priceImpactBps < 0
    ) {
      return null
    }
    depthCurve.push({ sizeUsd, priceImpactBps })
  }
  if (depthCurve.length === 0) return null

  const poolTvl = parseProviderNumber(data.poolTvl ?? data.totalSupply)
  const dailyVolume = parseProviderNumber(data.dailyVolume ?? 0)
  return {
    protocolName,
    assetSymbol,
    poolTvl: poolTvl !== null && poolTvl >= 0 ? poolTvl : availableLiquidity,
    availableLiquidity,
    dailyVolume: dailyVolume !== null && dailyVolume >= 0 ? dailyVolume : 0,
    withdrawalQueueDepth,
    withdrawalDelayHours,
    depthCurve,
  }
}

export function buildStellarDexLiquiditySnapshot(
  pools: unknown[],
  usdcAsset: string
): ProtocolLiquiditySnapshotInput | null {
  let availableLiquidity = 0
  for (const pool of pools) {
    if (typeof pool !== 'object' || pool === null || !('reserves' in pool)) {
      continue
    }
    const reserves = (pool as { reserves?: unknown }).reserves
    if (!Array.isArray(reserves)) continue
    const reserve = reserves.find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'asset' in item &&
        (item as { asset?: unknown }).asset === usdcAsset
    ) as { amount?: unknown } | undefined
    const amount = Number(reserve?.amount)
    if (Number.isFinite(amount) && amount > 0) availableLiquidity += amount
  }

  if (availableLiquidity <= 0) return null
  const maxExitAtTarget =
    (availableLiquidity * LIQUIDITY_CONFIG.TARGET_SLIPPAGE_BPS) /
    (10_000 - LIQUIDITY_CONFIG.TARGET_SLIPPAGE_BPS)

  return {
    protocolName: 'Stellar DEX',
    assetSymbol: 'USDC',
    poolTvl: availableLiquidity,
    availableLiquidity,
    dailyVolume: 0,
    withdrawalQueueDepth: 0,
    withdrawalDelayHours: 0,
    depthCurve: [
      {
        sizeUsd: maxExitAtTarget,
        priceImpactBps: LIQUIDITY_CONFIG.TARGET_SLIPPAGE_BPS,
      },
    ],
  }
}

export async function recordLiquiditySnapshot(
  snapshot: ProtocolLiquiditySnapshotInput,
  now = new Date()
): Promise<void> {
  const recent = await db.protocolLiquiditySnapshot.findFirst({
    where: {
      protocolName: snapshot.protocolName,
      assetSymbol: snapshot.assetSymbol,
      fetchedAt: {
        gte: new Date(now.getTime() - LIQUIDITY_CONFIG.SNAPSHOT_MAX_AGE_MS),
      },
    },
    select: { id: true },
  })
  if (recent) return

  await db.protocolLiquiditySnapshot.create({
    data: {
      ...snapshot,
      depthCurve: snapshot.depthCurve as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
    },
  })
}

export async function recordLiquiditySnapshotSafely(
  snapshot: ProtocolLiquiditySnapshotInput
): Promise<void> {
  try {
    await recordLiquiditySnapshot(snapshot)
  } catch (error) {
    logger.warn('Could not persist protocol liquidity snapshot', {
      protocolName: snapshot.protocolName,
      assetSymbol: snapshot.assetSymbol,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
