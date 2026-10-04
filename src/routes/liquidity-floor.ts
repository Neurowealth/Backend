import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { getLiquidityFloorStatus } from '../analytics/liquidityFloor'
import { sendError } from '../utils/errors'

const router = Router()

const updateLiquidityFloorSchema = z.object({
  body: z.object({
    floorUsd: z.number().finite().min(0).nullable(),
  }),
})

router.use(requireAuth)

router.get('/', async (req: Request, res: Response) => {
  const userId = req.userId
  if (!userId) return sendError(res, 401, 'Unauthorized')

  try {
    const status = await getLiquidityFloorStatus(userId)
    return res.json({
      floorUsd: status.floorUsd,
      totalBalanceUsd: status.totalBalanceUsd,
      liquidBalanceUsd: status.liquidBalanceUsd,
      availableForYieldUsd: status.availableForYieldUsd,
      shortfallUsd: status.shortfallUsd,
      estimatedRestoreHours: status.estimatedRestoreHours,
      dataAvailable: status.dataAvailable,
      floorExceedsBalance: status.floorExceedsBalance,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'User not found') {
      return sendError(res, 404, 'User not found')
    }
    throw error
  }
})

router.patch(
  '/',
  validate({ body: updateLiquidityFloorSchema.shape.body }),
  async (req: Request, res: Response) => {
    const userId = req.userId
    if (!userId) return sendError(res, 401, 'Unauthorized')

    const { floorUsd } = req.body as z.infer<
      typeof updateLiquidityFloorSchema.shape.body
    >
    const user = await db.user.updateMany({
      where: { id: userId },
      data: { liquidityFloor: floorUsd === null ? null : String(floorUsd) },
    })
    if (user.count === 0) return sendError(res, 404, 'User not found')

    return res.json(await getLiquidityFloorStatus(userId))
  }
)

export default router
