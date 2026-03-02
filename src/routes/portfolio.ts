import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { enforceUserAccess, requireAuth } from '../middleware/auth'
import {
  formatPortfolioEarningsReply,
  formatPortfolioHistoryReply,
  formatPortfolioReply,
} from '../whatsapp/formatters'

const router = Router()

const historyQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
})

router.get('/:userId', requireAuth, enforceUserAccess, async (req: Request, res: Response) => {
  const userId = String(req.params.userId)
  const user = await db.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const userPositions = await db.position.findMany({
    where: { userId },
  })

  const totalBalance = userPositions.reduce((sum, position) => {
    return sum + Number(position.currentValue)
  }, 0)
  const totalEarnings = userPositions.reduce((sum, position) => {
    return sum + Number(position.yieldEarned)
  }, 0)
  const activePositions = userPositions.filter((p) => p.status === 'ACTIVE').length

  const positions = userPositions.map((position) => ({
    id: position.id,
    protocolName: position.protocolName,
    assetSymbol: position.assetSymbol,
    currentValue: Number(position.currentValue),
    yieldEarned: Number(position.yieldEarned),
    status: position.status,
  }))

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
  async (req: Request, res: Response) => {
    const queryParsed = historyQuerySchema.safeParse(req.query)
    if (!queryParsed.success) {
      return res.status(400).json({
        error: 'Validation error',
        details: queryParsed.error.flatten(),
      })
    }

    const user = await db.user.findUnique({
      where: { id: String(req.params.userId) },
      select: { id: true },
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    const userId = String(req.params.userId)
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const periodDays =
      queryParsed.data.period === '7d'
        ? 7
        : queryParsed.data.period === '30d'
          ? 30
          : 90
    const fromDate = new Date(now - periodDays * dayMs)

    const snapshots = await db.yieldSnapshot.findMany({
      where: { position: { is: { userId } }, snapshotAt: { gte: fromDate } },
      orderBy: { snapshotAt: 'desc' },
      take: 30,
    })

    const points = snapshots.map((snapshot) => ({
      date: snapshot.snapshotAt.toISOString().slice(0, 10),
      yieldAmount: Number(snapshot.yieldAmount),
    }))

    return res.status(200).json({
      userId,
      period: queryParsed.data.period,
      points,
      whatsappReply: formatPortfolioHistoryReply({
        period: queryParsed.data.period,
        points,
      }),
    })
  },
)

router.get(
  '/:userId/earnings',
  requireAuth,
  enforceUserAccess,
  async (req: Request, res: Response) => {
    const user = await db.user.findUnique({
      where: { id: String(req.params.userId) },
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    const userId = String(req.params.userId)
    const userPositions = await db.position.findMany({
      where: { userId },
    })

    const snapshots = await db.yieldSnapshot.findMany({
      where: { position: { is: { userId } } },
      orderBy: { snapshotAt: 'desc' },
      take: 30,
    })

    const totalEarnings = userPositions.reduce((sum, position) => {
      return sum + Number(position.yieldEarned)
    }, 0)
    const periodEarnings = snapshots.reduce((sum, snapshot) => {
      return sum + Number(snapshot.yieldAmount)
    }, 0)
    const averageApy =
      snapshots.length > 0
        ? snapshots.reduce((sum, snapshot) => sum + Number(snapshot.apy), 0) /
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
