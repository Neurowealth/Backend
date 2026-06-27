import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { config } from '../config/env'
import {
  computeAnalyticsMetrics,
  periodToDays as utilPeriodToDays,
  SnapshotData,
} from '../utils/analytics'

const router = Router()

const periodSchema = z.object({
  period: z.enum(['7d', '30d', '90d', '1y']).default('30d'),
})

function periodToDays(period: string): number {
  return utilPeriodToDays(period)
}

/**
 * GET /analytics/apy-history
 * Returns APY snapshots over time for a user's positions (graph-ready).
 */
router.get('/apy-history', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(Date.now() - periodToDays(parsed.data.period) * 86400_000)

  const snapshots = await db.yieldSnapshot.findMany({
    where: { position: { userId }, snapshotAt: { gte: fromDate } },
    orderBy: { snapshotAt: 'asc' },
    select: { snapshotAt: true, apy: true, positionId: true },
  })

  const points = snapshots.map((s) => ({
    date: s.snapshotAt.toISOString().slice(0, 10),
    apy: Number(s.apy),
    positionId: s.positionId,
  }))

  return res.status(200).json({ userId, period: parsed.data.period, points })
})

/**
 * GET /analytics/user-yield
 * Returns cumulative and period yield earned by the authenticated user.
 */
router.get('/user-yield', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(Date.now() - periodToDays(parsed.data.period) * 86400_000)

  const [positions, snapshots] = await Promise.all([
    db.position.findMany({ where: { userId }, select: { yieldEarned: true, assetSymbol: true } }),
    db.yieldSnapshot.findMany({
      where: { position: { userId }, snapshotAt: { gte: fromDate } },
      orderBy: { snapshotAt: 'asc' },
      select: { snapshotAt: true, yieldAmount: true, apy: true },
    }),
  ])

  const totalYield = positions.reduce((sum, p) => sum + Number(p.yieldEarned), 0)
  const periodYield = snapshots.reduce((sum, s) => sum + Number(s.yieldAmount), 0)
  const averageApy =
    snapshots.length > 0
      ? snapshots.reduce((sum, s) => sum + Number(s.apy), 0) / snapshots.length
      : 0

  const points = snapshots.map((s) => ({
    date: s.snapshotAt.toISOString().slice(0, 10),
    yieldAmount: Number(s.yieldAmount),
    apy: Number(s.apy),
  }))

  return res.status(200).json({
    userId,
    period: parsed.data.period,
    totalYield,
    periodYield,
    averageApy,
    points,
  })
})

/**
 * GET /analytics/protocol-performance
 * Returns historical APY rates per protocol (graph-ready).
 */
router.get('/protocol-performance', async (req: Request, res: Response) => {
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(Date.now() - periodToDays(parsed.data.period) * 86400_000)

  const rates = await db.protocolRate.findMany({
    where: { fetchedAt: { gte: fromDate } },
    orderBy: { fetchedAt: 'asc' },
    select: {
      protocolName: true,
      assetSymbol: true,
      supplyApy: true,
      tvl: true,
      fetchedAt: true,
      network: true,
    },
  })

  // Group by protocol for graph-ready output
  const byProtocol: Record<string, { protocol: string; asset: string; network: string; points: { date: string; apy: number; tvl: number | null }[] }> = {}

  for (const r of rates) {
    const key = `${r.protocolName}:${r.assetSymbol}:${r.network}`
    if (!byProtocol[key]) {
      byProtocol[key] = { protocol: r.protocolName, asset: r.assetSymbol, network: r.network, points: [] }
    }
    byProtocol[key].points.push({
      date: r.fetchedAt.toISOString().slice(0, 10),
      apy: Number(r.supplyApy),
      tvl: r.tvl !== null ? Number(r.tvl) : null,
    })
  }

  return res.status(200).json({ period: parsed.data.period, protocols: Object.values(byProtocol) })
})

/**
 * GET /api/analytics
 * Returns portfolio analytics metrics computed from YieldSnapshot history.
 * Query: period=30d|90d|1y (default 30d)
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const period = parsed.data.period
  const days = periodToDays(period)
  const fromDate = new Date(Date.now() - days * 86400_000)

  // Fetch snapshots for the user in period + positions for allocation
  const [snapshotsRaw, positionsRaw] = await Promise.all([
    db.yieldSnapshot.findMany({
      where: {
        position: { userId },
        snapshotAt: { gte: fromDate },
      },
      orderBy: { snapshotAt: 'asc' },
      select: {
        snapshotAt: true,
        principalAmount: true,
        yieldAmount: true,
        apy: true,
        positionId: true,
        position: {
          select: { protocolName: true },
        },
      },
    }),
    db.position.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { protocolName: true, currentValue: true },
    }),
  ])

  // Map to SnapshotData shape
  const snapshots: SnapshotData[] = snapshotsRaw.map((s: any) => ({
    snapshotAt: s.snapshotAt,
    principalAmount: s.principalAmount,
    yieldAmount: s.yieldAmount,
    apy: s.apy,
    positionId: s.positionId,
    position: s.position,
  }))

  const positions = positionsRaw.map((p: any) => ({
    protocolName: p.protocolName,
    currentValue: p.currentValue,
  }))

  const rfRate = config.analytics?.riskFreeRate ?? 0

  const metrics = await computeAnalyticsMetrics(
    snapshots,
    positions,
    period,
    rfRate
  )

  const { period: _metricsPeriod, ...restMetrics } = metrics
  return res.status(200).json({
    userId,
    period,
    ...restMetrics,
    // Include a simple totalValue for convenience
    totalValue: snapshots.length > 0
      ? snapshots[snapshots.length - 1]
        ? (Number(snapshots[snapshots.length - 1].principalAmount) + Number(snapshots[snapshots.length - 1].yieldAmount))
        : 0
      : 0,
  })
})

export default router
