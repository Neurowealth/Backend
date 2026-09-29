import { Request, Response } from 'express'
import db from '../db'
import { logger } from '../utils/logger'
import { sendError, sendNotFound, sendUnauthorized } from '../utils/errors'
import {
  computeLiquidityFloorStatus,
  PositionLike,
} from '../agent/liquidityFloor'

/**
 * Maps database positions to PositionLike objects.
 */
function mapPositions(
  positions: Array<{
    id: string
    protocolName: string
    assetSymbol: string
    currentValue: { toString(): string }
    status: string
  }>
): PositionLike[] {
  return positions.map((p) => ({
    id: p.id,
    protocolName: p.protocolName,
    assetSymbol: p.assetSymbol,
    currentValue: p.currentValue.toString(),
    amount: p.currentValue.toString(),
    status: p.status,
  }))
}

/**
 * GET /api/v1/liquidity-floor
 * GET /api/v1/liquidity-floor/:userId
 *
 * Retrieves standing liquidity floor status and metrics for the user.
 */
export async function getLiquidityFloorHandler(
  req: Request,
  res: Response
): Promise<void> {
  const callerId = (req as any).userId
  if (!callerId) {
    sendUnauthorized(res)
    return
  }

  const targetUserId = req.params.userId || callerId
  if (targetUserId !== callerId) {
    sendError(res, 403, 'Forbidden: cannot access another user liquidity floor')
    return
  }

  try {
    const user = await db.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        liquidityFloor: true,
        strategyConfig: true,
      },
    })

    if (!user) {
      sendNotFound(res, 'User')
      return
    }

    const positions = await db.position.findMany({
      where: {
        userId: targetUserId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        protocolName: true,
        assetSymbol: true,
        currentValue: true,
        status: true,
      },
    })

    const strategyConfig = user.strategyConfig as Record<string, unknown> | null
    const effectiveFloor =
      user.liquidityFloor !== null && user.liquidityFloor !== undefined
        ? user.liquidityFloor.toString()
        : ((strategyConfig?.liquidityFloor as
            string | number | null | undefined) ?? null)

    const status = computeLiquidityFloorStatus({
      floor: effectiveFloor,
      positions: mapPositions(positions),
    })

    res.status(200).json({
      success: true,
      data: {
        userId: user.id,
        floor: status.floor,
        totalBalance: status.totalBalance,
        currentLiquidBalance: status.currentLiquidBalance,
        shortfall: status.shortfall,
        availableForYield: status.availableForYield,
        isSatisfied: status.isSatisfied,
        isDegraded: status.isDegraded,
        status: status.status,
        statusMessage: status.statusMessage,
        estimatedRestorationTimeHours: status.estimatedRestorationTimeHours,
        unwindPlan: status.unwindPlan,
      },
    })
  } catch (error) {
    logger.error('Failed to retrieve liquidity floor status:', error)
    sendError(res, 500, 'Failed to retrieve liquidity floor status')
  }
}

/**
 * PUT /api/v1/liquidity-floor
 * PUT /api/v1/liquidity-floor/:userId
 *
 * Sets or updates the standing liquidity floor for the user.
 */
export async function updateLiquidityFloorHandler(
  req: Request,
  res: Response
): Promise<void> {
  const callerId = (req as any).userId
  if (!callerId) {
    sendUnauthorized(res)
    return
  }

  const targetUserId = req.params.userId || callerId
  if (targetUserId !== callerId) {
    sendError(res, 403, 'Forbidden: cannot modify another user liquidity floor')
    return
  }

  const rawFloor = req.body?.liquidityFloor
  let normalizedFloor: string | null = null

  if (rawFloor !== undefined && rawFloor !== null) {
    const num = Number(rawFloor)
    if (isNaN(num) || num < 0) {
      sendError(res, 400, 'liquidityFloor must be a non-negative number')
      return
    }
    normalizedFloor = num.toString()
  }

  try {
    const updatedUser = await db.user.update({
      where: { id: targetUserId },
      data: {
        liquidityFloor: normalizedFloor,
      },
      select: {
        id: true,
        liquidityFloor: true,
      },
    })

    const positions = await db.position.findMany({
      where: {
        userId: targetUserId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        protocolName: true,
        assetSymbol: true,
        currentValue: true,
        status: true,
      },
    })

    const status = computeLiquidityFloorStatus({
      floor: updatedUser.liquidityFloor
        ? updatedUser.liquidityFloor.toString()
        : null,
      positions: mapPositions(positions),
    })

    res.status(200).json({
      success: true,
      data: {
        userId: updatedUser.id,
        floor: status.floor,
        totalBalance: status.totalBalance,
        currentLiquidBalance: status.currentLiquidBalance,
        shortfall: status.shortfall,
        availableForYield: status.availableForYield,
        isSatisfied: status.isSatisfied,
        isDegraded: status.isDegraded,
        status: status.status,
        statusMessage: status.statusMessage,
        estimatedRestorationTimeHours: status.estimatedRestorationTimeHours,
        unwindPlan: status.unwindPlan,
      },
    })
  } catch (error) {
    logger.error('Failed to update liquidity floor:', error)
    sendError(res, 500, 'Failed to update liquidity floor')
  }
}
