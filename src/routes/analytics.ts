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
import { getPortfolioCorrelation } from '../analytics/correlationService'
import { getYieldBreakdown } from '../analytics/yieldCompositionService'
import { RiskWindow } from '../analytics/metrics'
import { toCsv, CsvValue } from '../utils/csv'

const router = Router()

const periodSchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
})

const exportFormatSchema = z.object({
  format: z.enum(['csv']).default('csv'),
})

/**
 * CSV export headers/rows for /user-yield (#405). One row per yield
 * snapshot point, with the period-level totals repeated on every row so the
 * file stays self-describing once it leaves the API (pasted into a sheet,
 * handed to an accountant).
 */
const USER_YIELD_CSV_HEADERS = [
  'userId',
  'period',
  'totalYield',
  'periodYield',
  'averageApy',
  'date',
  'yieldAmount',
  'apy',
]

function userYieldToCsvRows(data: {
  userId: string
  period: string
  totalYield: number
  periodYield: number
  averageApy: number
  points: { date: string; yieldAmount: number; apy: number }[]
}): CsvValue[][] {
  if (data.points.length === 0) {
    return [
      [
        data.userId,
        data.period,
        data.totalYield,
        data.periodYield,
        data.averageApy,
        null,
        null,
        null,
      ],
    ]
  }

  return data.points.map((p) => [
    data.userId,
    data.period,
    data.totalYield,
    data.periodYield,
    data.averageApy,
    p.date,
    p.yieldAmount,
    p.apy,
  ])
}

/**
 * CSV export headers/rows for /attribution (#405). One row per sector, with
 * the portfolio-level attribution figures repeated on every row. When the
 * attribution hasn't been computed yet, a single row records that.
 */
const ATTRIBUTION_CSV_HEADERS = [
  'userId',
  'window',
  'computed',
  'portfolioReturn',
  'benchmarkReturn',
  'vsBenchmark',
  'allocationEffect',
  'selectionEffect',
  'unattributedEffect',
  'reconciliationGap',
  'reconciled',
  'benchmarkVersion',
  'computedAt',
  'sector',
  'sectorPortfolioWeight',
  'sectorBenchmarkWeight',
  'sectorPortfolioReturn',
  'sectorBenchmarkReturn',
  'sectorAllocationEffect',
  'sectorSelectionEffect',
]

type AttributionResponse = ReturnType<typeof mapPortfolioAttributionToResponse>

function attributionToCsvRows(
  userId: string,
  window: string,
  attribution: AttributionResponse | null
): CsvValue[][] {
  if (!attribution) {
    return [[userId, window, false, ...Array(17).fill(null)]]
  }

  const base = [
    userId,
    window,
    true,
    attribution.portfolioReturn,
    attribution.benchmarkReturn,
    attribution.vsBenchmark,
    attribution.allocationEffect,
    attribution.selectionEffect,
    attribution.unattributedEffect,
    attribution.reconciliationGap,
    attribution.reconciled,
    attribution.benchmarkVersion,
    attribution.computedAt,
  ]

  if (attribution.sectors.length === 0) {
    return [[...base, null, null, null, null, null, null, null]]
  }

  return attribution.sectors.map((sector) => [
    ...base,
    sector.sector,
    sector.portfolioWeight,
    sector.benchmarkWeight,
    sector.portfolioReturn,
    sector.benchmarkReturn,
    sector.allocationEffect,
    sector.selectionEffect,
  ])
}

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
 * GET /analytics/user-yield/export
 * CSV export of the same data as /user-yield (#405). Registered before
 * /user-yield so "export" is never captured as anything else.
 */
router.get(
  '/user-yield/export',
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const period = periodSchema.safeParse(req.query)
    const format = exportFormatSchema.safeParse(req.query)
    if (!period.success || !format.success) {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          ...(period.success ? {} : period.error.flatten()),
          ...(format.success ? {} : format.error.flatten()),
        },
      })
    }

    const fromDate = new Date(
      Date.now() - periodToDays(period.data.period) * 86400_000
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
        ? snapshots.reduce((sum, s) => sum + Number(s.apy), 0) /
          snapshots.length
        : 0

    const points = snapshots.map((s) => ({
      date: s.snapshotAt.toISOString().slice(0, 10),
      yieldAmount: Number(s.yieldAmount),
      apy: Number(s.apy),
    }))

    const csv = toCsv(
      USER_YIELD_CSV_HEADERS,
      userYieldToCsvRows({
        userId,
        period: period.data.period,
        totalYield,
        periodYield,
        averageApy,
        points,
      })
    )

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="user-yield-${period.data.period}.csv"`
    )
    return res.status(200).send(csv)
  }
)

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
 * GET /analytics/attribution/export
 * CSV export of the same data as /attribution (#405). Registered before
 * /attribution so "export" is never captured as a value in a future
 * /attribution/:something route.
 */
router.get(
  '/attribution/export',
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const query = attributionQuerySchema.safeParse(req.query)
    const format = exportFormatSchema.safeParse(req.query)
    if (!query.success || !format.success) {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          ...(query.success ? {} : query.error.flatten()),
          ...(format.success ? {} : format.error.flatten()),
        },
      })
    }

    const windowDays = attributionWindowToDays(query.data.window)

    const row = await db.portfolioAttribution.findUnique({
      where: { userId_windowDays: { userId, windowDays } },
    })

    const attribution = row ? mapPortfolioAttributionToResponse(row) : null

    const csv = toCsv(
      ATTRIBUTION_CSV_HEADERS,
      attributionToCsvRows(userId, query.data.window, attribution)
    )

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="attribution-${query.data.window}.csv"`
    )
    return res.status(200).send(csv)
  }
)

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

/**
 * GET /analytics/correlation
 * Returns the per-protocol APY correlation matrix and a weighted
 * diversification score for the authenticated user's portfolio.
 */
router.get('/correlation', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const parsed = riskQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation error', details: parsed.error.flatten() })
  }

  const window = parsed.data.window as RiskWindow
  const lookbackDays = window === '90d' ? 90 : window === '60d' ? 60 : 30

  const result = await getPortfolioCorrelation(userId, { lookbackDays })

  // Null-on-degenerate: distinguish "genuinely high correlation" from
  // "not enough data to say" — empty matrix + null score, never 0/1.
  if (result.protocols.length < 2) {
    return res.status(200).json({
      userId,
      window: parsed.data.window,
      computed: false,
      observationCount: result.observationCount,
      protocols: [],
      correlation: [],
      averageCorrelation: null,
      diversificationScore: null,
      excluded: result.excluded,
      caveat: result.caveat,
    })
  }

  return res.status(200).json({
    userId,
    window: parsed.data.window,
    computed: true,
    observationCount: result.observationCount,
    protocols: result.protocols,
    correlation: result.correlation,
    averageCorrelation: result.averageCorrelation,
    diversificationScore: result.diversificationScore,
    caveat: result.caveat,
  })
})

/**
 * GET /analytics/yield-breakdown
 * Returns the base-vs-incentive composition and effective APY for the
 * authenticated user's held protocols (all protocols when they hold none).
 */
router.get(
  '/yield-breakdown',
  requireAuth,
  async (_req: Request, res: Response) => {
    const userId = _req.auth!.userId
    const result = await getYieldBreakdown(userId)
    return res.status(200).json({
      userId,
      ...result,
    })
  }
)

export default router
