/**
 * Factor-exposure DB glue (#352).
 *
 * Reads the DB (the user's YieldSnapshot value buckets for the portfolio
 * series, ProtocolRate history on the configured benchmark universe for the
 * market series) and hands the ALIGNED daily-return pairs to the pure cores in
 * src/analytics/benchmark.ts + src/analytics/factorExposure.ts. No statistics
 * live here — mirroring src/analytics/correlationService.ts.
 *
 * ─── ALIGNMENT (shared daily grid, never zero-fill) ──────────────────────────
 *
 * The portfolio value series and the market factor series are both built on
 * the same UTC-day grid. Only days on which BOTH a portfolio daily return and
 * a market daily return exist are kept as aligned observation pairs; any day
 * missing on either side is dropped, never zero-filled. `sampleCount` is the
 * size of that intersection.
 *
 * ─── RETENTION & VALIDATION ──────────────────────────────────────────────────
 *
 * Yield snapshots are hard-deleted past 90 days (src/agent/snapshotter.ts), so
 * the window is capped at 90d and the API refuses `rollingWindow >= window`.
 * A rollingWindow that leaves fewer than 2 windows is reported as summary-only
 * with a caveat rather than a fabricated trend.
 */

import crypto from 'crypto'
import db from '../db'
import { config } from '../config/env'
import {
  buildMarketFactorSeries,
  BenchmarkRatePoint,
  MarketFactorDay,
} from './benchmark'
import {
  rollingBeta,
  factorDecomposition,
  MIN_FACTOR_SAMPLES,
  RollingBetaPoint,
} from './factorExposure'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 90

/**
 * The fixed caveat that ships with every factor-exposure response. "Beta" here
 * is yield co-movement, never price beta, and the market is a synthetic
 * tracked-protocol average, not a traded index.
 */
export const FACTOR_CAVEAT =
  "The 'market' is the equal-weighted average of tracked protocol APY series, not a traded index. Beta here measures yield co-movement, not price beta."

export type FactorExposureWeighting = 'equal' | 'tvl'

export interface FactorExposureOptions {
  /** Trailing window in days (capped at 90). Default 90. */
  windowDays?: number
  /** Rolling window in samples (days). Must be < windowDays. Default 30. */
  rollingWindowDays?: number
  /** 'equal' (default) or 'tvl'. */
  weighting?: FactorExposureWeighting
  /** Reference "now", injected for deterministic tests. */
  now?: Date
}

export interface FactorExposureResult {
  userId: string
  windowDays: number
  actualWindowDays: number
  rollingWindowDays: number
  /** True when there aren't enough aligned samples for beta to mean anything. */
  insufficientHistory: boolean
  /** Number of aligned (intersected) daily observations. */
  sampleCount: number
  rolling: RollingBetaPoint[]
  summary: {
    sampleCount: number
    beta: number | null
    alpha: number | null
    alphaAnnualized: number | null
    rSquared: number | null
    idiosyncraticVolShare: number | null
  } | null
  benchmark: {
    weighting: FactorExposureWeighting
    universeSize: number
    tvlFallback: boolean
  }
  /** Always includes FACTOR_CAVEAT; may add reason-specific caveats. */
  caveats: string[]
  inputHash: string
  computedAt: string
}

/** Whole-portfolio value per UTC day for a user (end-of-day mark from YieldSnapshot value buckets). */
async function loadPortfolioValueSeries(
  userId: string,
  fromDate: Date,
  now: Date
): Promise<Map<number, number>> {
  const snapshots = await db.yieldSnapshot.findMany({
    where: {
      position: { userId },
      snapshotAt: { gte: fromDate, lte: now },
    },
    select: {
      snapshotAt: true,
      principalAmount: true,
      yieldAmount: true,
    },
    orderBy: { snapshotAt: 'asc' },
  })

  const dayValue = new Map<number, number>()
  const dayTs = new Map<number, number>()
  for (const s of snapshots) {
    const day = Math.floor(s.snapshotAt.getTime() / MS_PER_DAY) * MS_PER_DAY
    const ts = s.snapshotAt.getTime()
    const prevTs = dayTs.get(day)
    // Latest snapshot of the day wins (end-of-day mark), order-independent.
    if (prevTs !== undefined && prevTs >= ts) continue
    dayTs.set(day, ts)
    dayValue.set(day, Number(s.principalAmount) + Number(s.yieldAmount))
  }
  return dayValue
}

/** The benchmark universe's raw rate observations (optionally with tvl), filtered to the configured subset. */
async function loadBenchmarkRates(
  fromDate: Date
): Promise<BenchmarkRatePoint[]> {
  const subset = config.attribution.benchmarkProtocols
  const rates = await db.protocolRate.findMany({
    where: {
      fetchedAt: { gte: fromDate },
      ...(subset.length > 0 ? { protocolName: { in: subset } } : {}),
    },
    select: {
      protocolName: true,
      assetSymbol: true,
      supplyApy: true,
      tvl: true,
      fetchedAt: true,
    },
  })

  return rates.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    apy: Number(r.supplyApy),
    tvl: r.tvl != null ? Number(r.tvl) : null,
    date: r.fetchedAt,
  }))
}

/**
 * Intersect the portfolio value series with the market factor series on the
 * shared day grid, producing aligned (portfolioDailyReturn, marketDailyReturn)
 * pairs. Days missing on either side are dropped, never zero-filled.
 */
function intersectDailyReturns(
  portfolioByDay: Map<number, number>,
  startDay: number,
  endDay: number,
  market: MarketFactorDay[]
): { portfolioReturns: number[]; marketReturns: number[] } {
  const marketByDay = new Map<number, number>()
  for (const day of market) {
    if (day.marketReturn !== null) {
      marketByDay.set(day.date.getTime(), day.marketReturn)
    }
  }

  const portfolioReturns: number[] = []
  const marketReturns: number[] = []
  let prevValue: number | null = null
  for (let day = startDay; day <= endDay; day += MS_PER_DAY) {
    const value = portfolioByDay.get(day)
    const mkt = marketByDay.get(day)
    if (value !== undefined && prevValue !== null && mkt !== undefined) {
      if (prevValue > 0) {
        portfolioReturns.push((value - prevValue) / prevValue)
        marketReturns.push(mkt)
      }
    }
    if (value !== undefined) prevValue = value
  }

  return { portfolioReturns, marketReturns }
}

function snapshotHash(parts: {
  portfolio: Map<number, number>
  rates: BenchmarkRatePoint[]
  windowDays: number
  weighting: string
}): string {
  const sortedRates = [...parts.rates]
    .sort((a, b) =>
      a.date.getTime() !== b.date.getTime()
        ? a.date.getTime() - b.date.getTime()
        : a.protocolName < b.protocolName
          ? -1
          : 1
    )
    .map((r) => `${r.protocolName}:${r.apy.toFixed(9)}:${r.date.getTime()}`)

  const portfolio = Array.from(parts.portfolio.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([d, v]) => `${d}:${v.toFixed(9)}`)

  const canonical = JSON.stringify({
    portfolio,
    rates: sortedRates,
    windowDays: parts.windowDays,
    weighting: parts.weighting,
  })
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex')
}

/**
 * Compute the full factor-exposure report for one user.
 */
export async function getFactorExposure(
  userId: string,
  options: FactorExposureOptions = {}
): Promise<FactorExposureResult> {
  const now = options.now ?? new Date()
  const weighting: FactorExposureWeighting = options.weighting ?? 'equal'

  const requestedWindow = options.windowDays ?? RETENTION_DAYS
  const actualWindowDays = Math.min(requestedWindow, RETENTION_DAYS)
  const rollingWindowDays =
    options.rollingWindowDays ?? Math.min(30, actualWindowDays - 1)

  const endDay = Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY
  const startDay = endDay - actualWindowDays * MS_PER_DAY
  const fromDate = new Date(startDay)

  const [portfolioByDay, benchmarkRates] = await Promise.all([
    loadPortfolioValueSeries(userId, fromDate, now),
    loadBenchmarkRates(fromDate),
  ])

  const factor = buildMarketFactorSeries({
    rates: benchmarkRates,
    startDate: new Date(startDay),
    endDate: new Date(endDay),
    weighting,
  })

  const universeSize = new Set(
    factor.series.flatMap((d) => d.sectors.map((s) => s.name))
  ).size

  const { portfolioReturns, marketReturns } = intersectDailyReturns(
    portfolioByDay,
    startDay,
    endDay,
    factor.series
  )

  const sampleCount = portfolioReturns.length
  const inputHash = snapshotHash({
    portfolio: portfolioByDay,
    rates: benchmarkRates,
    windowDays: actualWindowDays,
    weighting,
  })

  const caveats: string[] = [FACTOR_CAVEAT]

  const summary =
    sampleCount >= MIN_FACTOR_SAMPLES
      ? factorDecomposition({
          portfolioReturns,
          marketReturns,
        })
      : null

  let rolling: RollingBetaPoint[] = []
  if (
    sampleCount >= 2 &&
    rollingWindowDays > 0 &&
    rollingWindowDays < sampleCount
  ) {
    rolling = rollingBeta({
      portfolioReturns,
      marketReturns,
      windowSize: rollingWindowDays,
      step: rollingWindowDays,
      timestampsMs: portfolioReturns.map(
        (_, i) => startDay + (i + 1) * MS_PER_DAY
      ),
    })
  }

  // < 2 windows: report the summary only, with a caveat (residual from the spec).
  if (rolling.length < 2) {
    caveats.push(
      `Rolling window of ${rollingWindowDays}d over ${sampleCount} aligned observations leaves fewer than 2 windows; only the full-window summary is reported.`
    )
  }

  // Degenerate market variance flag (all protocols moved together / forward-fill dominated).
  if (summary && summary.beta === null && sampleCount >= MIN_FACTOR_SAMPLES) {
    caveats.push(
      'The market factor shows effectively zero variance over this window (all protocols moved together or forward-fill dominated), so beta/R² are reported as null.'
    )
  }

  return {
    userId,
    windowDays: requestedWindow,
    actualWindowDays,
    rollingWindowDays,
    insufficientHistory: sampleCount < MIN_FACTOR_SAMPLES,
    sampleCount,
    rolling,
    summary,
    benchmark: {
      weighting: factor.weighting === 'tvl' ? 'tvl' : 'equal',
      universeSize,
      tvlFallback: factor.tvlFallback,
    },
    caveats,
    inputHash,
    computedAt: now.toISOString(),
  }
}
