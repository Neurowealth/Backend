import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { enforceUserAccess, requireAuth } from '../middleware/auth'
import { validate } from '../middleware/validate'
import { mapPositionToResponse } from '../utils/api-formatters'
import { sendNotFound } from '../utils/errors'
import {
  formatPortfolioEarningsReply,
  formatPortfolioHistoryReply,
  formatPortfolioReply,
} from '../whatsapp/formatters'

const router = Router()

const portfolioSchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
})

const historySchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
  query: z.object({
    period: z.enum(['7d', '30d', '90d']).default('30d'),
  }),
})

router.get('/:userId', requireAuth, enforceUserAccess, validate(portfolioSchema), async (req: Request, res: Response) => {
  const userId = req.params.userId as string
  const user = await db.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    return sendNotFound(res, 'User')
  }

  const userPositions = await db.position.findMany({
    where: { userId },
  })

  const totalBalance = userPositions.reduce((sum: number, position: any) => {
    return sum + Number(position.currentValue)
  }, 0)
  const totalEarnings = userPositions.reduce((sum: number, position: any) => {
    return sum + Number(position.yieldEarned)
  }, 0)
  const activePositions = userPositions.filter((p: any) => p.status === 'ACTIVE').length

  const positions = userPositions.map(mapPositionToResponse)

  return res.status(200).json({
    userId: user.id,
    totalBalance,
    totalEarnings,
    activePositions,
    positions,
    whatsappReply: formatPortfolioReply({
      totalBalance,
      totalEarnings,
      activePositions,
      positions,
    }),
  })
})

router.get(
  '/:userId/history',
  requireAuth,
  enforceUserAccess,
  validate(historySchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })

    if (!user) {
      return sendNotFound(res, 'User')
    }

    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const periodDays =
      req.query.period === '7d'
        ? 7
        : req.query.period === '30d'
          ? 30
          : 90
    const fromDate = new Date(now - periodDays * dayMs)

    const snapshots = await db.yieldSnapshot.findMany({
      where: { position: { is: { userId } }, snapshotAt: { gte: fromDate } },
      orderBy: { snapshotAt: 'desc' },
      take: 30,
    })

    const points = snapshots.map((snapshot: any) => ({
      date: snapshot.snapshotAt.toISOString().slice(0, 10),
      yieldAmount: Number(snapshot.yieldAmount),
    }))

    return res.status(200).json({
      userId,
      period: req.query.period,
      points,
      whatsappReply: formatPortfolioHistoryReply({
        period: req.query.period as any,
        points,
      }),
    })
  },
)

router.get(
  '/:userId/earnings',
  requireAuth,
  enforceUserAccess,
  validate(portfolioSchema),
  async (req: Request, res: Response) => {
    const userId = req.params.userId as string
    const user = await db.user.findUnique({
      where: { id: userId },
    })

    if (!user) {
      return sendNotFound(res, 'User')
    }

    const userPositions = await db.position.findMany({
      where: { userId },
    })

    const snapshots = await db.yieldSnapshot.findMany({
      where: { position: { is: { userId } } },
      orderBy: { snapshotAt: 'desc' },
      take: 30,
    })

    const totalEarnings = userPositions.reduce((sum: number, position: any) => {
      return sum + Number(position.yieldEarned)
    }, 0)
    const periodEarnings = snapshots.reduce((sum: number, snapshot: any) => {
      return sum + Number(snapshot.yieldAmount)
    }, 0)
    const averageApy =
      snapshots.length > 0
        ? snapshots.reduce(
            (sum: number, snapshot: any) => sum + Number(snapshot.apy),
            0
          ) /
          snapshots.length
        : 0

    return res.status(200).json({
      userId,
      totalEarnings,
      periodEarnings,
      averageApy,
      whatsappReply: formatPortfolioEarningsReply({
        totalEarnings,
        periodEarnings,
        averageApy,
      }),
    })
  },
)

export default router
