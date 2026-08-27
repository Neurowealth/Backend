import { Router, Request, Response } from 'express'
import { z } from 'zod'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { mapPortfolioAttributionToResponse } from '../utils/api-formatters'
import {
  getPortfolioRiskMetrics,
  getPortfolioRiskTimeseries,
  getStrategyRiskMetrics,
  getPersistedUserRisk,
} from '../analytics/riskService'
import { RiskWindow } from '../analytics/metrics'

const router = Router()

const periodSchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
})

function periodToDays(period: string): number {
  return period === '7d' ? 7 : period === '30d' ? 30 : 90
}

const attributionQuerySchema = z.object({
  window: z
    .enum(['30d', '90d'], {
      error:
        'window must be "30d" or "90d". Longer windows are unavailable because yield snapshots are retained for 90 days.',
    })
    .default('30d'),
})

function attributionWindowToDays(window: '30d' | '90d'): number {
  return window === '30d' ? 30 : 90
}

const riskQuerySchema = z.object({
  window: z.enum(['30d', '60d', '90d']).default('90d'),
})

/**
 * GET /analytics/apy-history
 * Returns APY snapshots over time for a user's positions (graph-ready).
 */
router.get('/apy-history', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = periodSchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(
    Date.now() - periodToDays(parsed.data.period) * 86400_000
  )

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
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(
    Date.now() - periodToDays(parsed.data.period) * 86400_000
  )

  const [positions, snapshots] = await Promise.all([
    db.position.findMany({
      where: { userId },
      select: { yieldEarned: true, assetSymbol: true },
    }),
    db.yieldSnapshot.findMany({
      where: { position: { userId }, snapshotAt: { gte: fromDate } },
      orderBy: { snapshotAt: 'asc' },
      select: { snapshotAt: true, yieldAmount: true, apy: true },
    }),
  ])

  const totalYield = positions.reduce(
    (sum, p) => sum + Number(p.yieldEarned),
    0
  )
  const periodYield = snapshots.reduce(
    (sum, s) => sum + Number(s.yieldAmount),
    0
  )
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
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const fromDate = new Date(
    Date.now() - periodToDays(parsed.data.period) * 86400_000
  )

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

  const byProtocol: Record<
    string,
    {
      protocol: string
      asset: string
      network: string
      points: { date: string; apy: number; tvl: number | null }[]
    }
  > = {}

  for (const r of rates) {
    const key = `${r.protocolName}:${r.assetSymbol}:${r.network}`
    if (!byProtocol[key]) {
      byProtocol[key] = {
        protocol: r.protocolName,
        asset: r.assetSymbol,
        network: r.network,
        points: [],
      }
    }
    byProtocol[key].points.push({
      date: r.fetchedAt.toISOString().slice(0, 10),
      apy: Number(r.supplyApy),
      tvl: r.tvl !== null ? Number(r.tvl) : null,
    })
  }

  return res
    .status(200)
    .json({ period: parsed.data.period, protocols: Object.values(byProtocol) })
})

/**
 * GET /analytics/attribution
 */
router.get('/attribution', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = attributionQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const windowDays = attributionWindowToDays(parsed.data.window)

  const row = await db.portfolioAttribution.findUnique({
    where: { userId_windowDays: { userId, windowDays } },
  })

  if (!row) {
    return res.status(200).json({
      userId,
      window: parsed.data.window,
      computed: false,
    })
  }

  return res.status(200).json({
    userId,
    window: parsed.data.window,
    computed: true,
    ...mapPortfolioAttributionToResponse(row),
  })
})

/**
 * GET /analytics/risk
 * Returns precomputed or live portfolio risk metrics for the authenticated user.
 */
router.get('/risk', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = riskQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const window = parsed.data.window as RiskWindow
  const persisted = await getPersistedUserRisk(userId, window)

  if (persisted) {
    return res.status(200).json({
      userId,
      requestedWindow: window,
      actualWindowDays: Math.min(
        parsed.data.window === '30d'
          ? 30
          : parsed.data.window === '60d'
            ? 60
            : 90,
        90
      ),
      insufficientHistory: persisted.insufficientHistory,
      sampleCount: persisted.sampleCount,
      metrics: {
        annualisedVolatility: persisted.annualisedVolatility
          ? Number(persisted.annualisedVolatility)
          : null,
        sortinoRatio: persisted.sortinoRatio
          ? Number(persisted.sortinoRatio)
          : null,
        downsideDeviation: persisted.downsideDeviation
          ? Number(persisted.downsideDeviation)
          : null,
        maxDrawdown: persisted.maxDrawdown
          ? Number(persisted.maxDrawdown)
          : null,
        maxDrawdownDuration: persisted.maxDrawdownDuration,
        valueAtRisk: {
          varHistorical95: persisted.varHistorical95
            ? Number(persisted.varHistorical95)
            : null,
          varHistorical99: persisted.varHistorical99
            ? Number(persisted.varHistorical99)
            : null,
          varParametric95: persisted.varParametric95
            ? Number(persisted.varParametric95)
            : null,
          varParametric99: persisted.varParametric99
            ? Number(persisted.varParametric99)
            : null,
          cvarHistorical95: persisted.cvarHistorical95
            ? Number(persisted.cvarHistorical95)
            : null,
          cvarHistorical99: persisted.cvarHistorical99
            ? Number(persisted.cvarHistorical99)
            : null,
        },
        beta: persisted.beta ? Number(persisted.beta) : null,
      },
      computedAt: persisted.computedAt.toISOString(),
      cached: true,
    })
  }

  const result = await getPortfolioRiskMetrics(userId, window)
  return res.status(200).json({ ...result, cached: false })
})

/**
 * GET /analytics/risk/timeseries
 * Returns daily portfolio value, return, and drawdown time-series.
 */
router.get(
  '/risk/timeseries',
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const parsed = riskQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation error', details: parsed.error.flatten() })
    }

    const window = parsed.data.window as RiskWindow
    const result = await getPortfolioRiskTimeseries(userId, window)
    return res.status(200).json(result)
  }
)

/**
 * GET /analytics/risk/strategy/:publishedStrategyId
 * Returns risk metrics for a published strategy.
 */
router.get(
  '/risk/strategy/:publishedStrategyId',
  async (req: Request, res: Response) => {
    const { publishedStrategyId } = req.params
    const parsed = riskQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation error', details: parsed.error.flatten() })
    }

    const window = parsed.data.window as RiskWindow
    const result = await getStrategyRiskMetrics(publishedStrategyId, window)
    return res.status(200).json(result)
  }
)

export default router
