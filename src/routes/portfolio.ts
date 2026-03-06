import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'
import { whatsappFormatters } from '../whatsapp/formatters'
import { logger } from '../utils/logger'
import { Decimal } from 'decimal.js'

const router = Router()

// Validation schemas
const userIdSchema = z.string().uuid()
const historyPeriodSchema = z.enum(['7d', '30d', '90d']).optional().default('30d')

/**
 * GET /api/portfolio/:userId
 * Get user's portfolio overview with all active positions
 */
router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = userIdSchema.parse(req.params.userId)

    // Verify user can only access their own portfolio
    if (req.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot access other users portfolio' })
      return
    }

    const user = await db.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' })
      return
    }

    const positions = await db.position.findMany({
      where: {
        userId: userId,
        status: 'ACTIVE'
      },
      include: {
        yieldSnapshots: {
          orderBy: { snapshotAt: 'desc' },
          take: 1
        }
      }
    })

    // Calculate totals
    let totalBalance = new Decimal(0)
    let totalYield = new Decimal(0)

    positions.forEach((pos: any) => {
      totalBalance = totalBalance.plus(pos.currentValue)
      totalYield = totalYield.plus(pos.yieldEarned)
    })

    const portfolioData = {
      userId,
      totalBalance: totalBalance.toString(),
      totalYield: totalYield.toString(),
      positionCount: positions.length,
      positions: positions.map((pos: any) => ({
        id: pos.id,
        protocolName: pos.protocolName,
        assetSymbol: pos.assetSymbol,
        depositedAmount: pos.depositedAmount.toString(),
        currentValue: pos.currentValue.toString(),
        yieldEarned: pos.yieldEarned.toString(),
        apy: pos.yieldSnapshots[0]?.apy.toString() || '0',
        status: pos.status
      })),
      whatsappReply: whatsappFormatters.formatPortfolio({
        totalBalance: totalBalance.toString(),
        totalYield: totalYield.toString(),
        positions: positions.map((pos: any) => ({
          protocolName: pos.protocolName,
          assetSymbol: pos.assetSymbol,
          amount: pos.depositedAmount.toString(),
          currentValue: pos.currentValue.toString(),
          apy: pos.yieldSnapshots[0]?.apy.toString() || '0'
        }))
      })
    }

    res.status(200).json(portfolioData)
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.issues })
      return
    }
    logger.error('Portfolio endpoint error', { error, userId: req.params.userId })
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/portfolio/:userId/history?period=7d|30d|90d
 * Get portfolio history for a specific period
 */
router.get('/:userId/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = userIdSchema.parse(req.params.userId)
    const period = historyPeriodSchema.parse(req.query.period as string)

    if (req.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot access other users data' })
      return
    }

    const user = await db.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' })
      return
    }

    // Calculate date range
    const now = new Date()
    const daysBack = period === '7d' ? 7 : period === '30d' ? 30 : 90
    const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)

    // Get yield snapshots for the period
    const snapshots = await db.yieldSnapshot.findMany({
      where: {
        position: { userId: userId },
        snapshotAt: {
          gte: startDate,
          lte: now
        }
      },
      include: {
        position: true
      },
      orderBy: { snapshotAt: 'asc' }
    })

    const historyData = {
      userId,
      period,
      startDate,
      endDate: now,
      snapshotCount: snapshots.length,
      snapshots: snapshots.map((snap: any) => ({
        date: snap.snapshotAt,
        protocol: snap.position.protocolName,
        asset: snap.position.assetSymbol,
        apy: snap.apy.toString(),
        yieldAmount: snap.yieldAmount.toString(),
        principalAmount: snap.principalAmount.toString()
      })),
      whatsappReply:
        snapshots.length === 0
          ? `📈 *Portfolio History*\n\n_No data for ${period}_`
          : `📈 *Portfolio History (${period})*\n\n` +
            `Snapshots recorded: ${snapshots.length}\n` +
            `Period: ${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}`
    }

    res.status(200).json(historyData)
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.issues })
      return
    }
    logger.error('Portfolio history endpoint error', { error, userId: req.params.userId })
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/portfolio/:userId/earnings
 * Get earnings summary and breakdown by protocol
 */
router.get('/:userId/earnings', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = userIdSchema.parse(req.params.userId)

    if (req.userId !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot access other users data' })
      return
    }

    const user = await db.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' })
      return
    }

    const positions = await db.position.findMany({
      where: {
        userId: userId
      },
      include: {
        yieldSnapshots: {
          orderBy: { snapshotAt: 'desc' },
          take: 1
        }
      }
    })

    let totalEarned = new Decimal(0)
    let totalPrincipal = new Decimal(0)
    const protocolBreakdown: Record<string, Decimal> = {}

    positions.forEach((pos: any) => {
      const yieldAmount = pos.yieldEarned
      totalEarned = totalEarned.plus(yieldAmount)
      totalPrincipal = totalPrincipal.plus(pos.depositedAmount)

      if (!protocolBreakdown[pos.protocolName]) {
        protocolBreakdown[pos.protocolName] = new Decimal(0)
      }
      protocolBreakdown[pos.protocolName] = protocolBreakdown[pos.protocolName].plus(yieldAmount)
    })

    const averageApy =
      positions.length > 0
        ? positions
            .reduce((sum: any, pos: any) => sum.plus(pos.yieldSnapshots[0]?.apy || new Decimal(0)), new Decimal(0))
            .div(positions.length)
            .toString()
        : '0'

    const earningsData = {
      userId,
      totalEarned: totalEarned.toString(),
      totalPrincipal: totalPrincipal.toString(),
      averageApy,
      apyPercent: parseFloat(averageApy).toFixed(2),
      breakdown: Object.entries(protocolBreakdown).map(([protocol, earned]) => ({
        protocol,
        earned: earned.toString()
      })),
      whatsappReply: whatsappFormatters.formatEarnings({
        totalEarned: totalEarned.toString(),
        averageApy: parseFloat(averageApy).toFixed(2),
        period: 'All time',
        breakdown: Object.entries(protocolBreakdown).map(([protocol, earned]) => ({
          protocol,
          earned: earned.toString()
        }))
      })
    }

    res.status(200).json(earningsData)
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.issues })
      return
    }
    logger.error('Portfolio earnings endpoint error', { error, userId: req.params.userId })
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
