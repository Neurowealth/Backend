/**
 * src/analytics/riskService.ts
 *
 * Portfolio Risk Engine — I/O layer.
 *
 * This module wraps the pure, zero-I/O analytics engine in `metrics.ts` with
 * database reads and writes. It is the authoritative source for persisted risk
 * aggregates and the live-compute path that the API routes call when no
 * precomputed row exists.
 *
 * ─── SEPARATION OF CONCERNS ────────────────────────────────────────────────
 * The pure engine (metrics.ts) is intentionally zero-I/O so it can be
 * unit-tested with fixture series. This module handles ONLY:
 *   1. Reading YieldSnapshot history from the DB
 *   2. Calling the pure engine
 *   3. Writing/reading PortfolioRiskAggregate rows
 */

import db from '../db'
import {
  RiskMetrics,
  RiskWindow,
  ValuePoint,
  computeAllMetrics,
  parseRiskWindowDays,
} from './metrics'

export type { RiskWindow }

export interface PortfolioRiskResult {
  userId: string
  requestedWindow: RiskWindow
  actualWindowDays: number
  insufficientHistory: boolean
  sampleCount: number
  metrics: RiskMetrics | null
  dataFrom?: string | null
  dataTo?: string | null
  computedAt: string
}

export interface PortfolioRiskTimeseriesResult {
  userId: string
  requestedWindow: RiskWindow
  points: Array<{
    timestampMs: number
    date: string
    portfolioValue: number
    dailyReturn: number | null
    drawdown: number
  }>
  computedAt: string
}

export interface StrategyRiskResult {
  publishedStrategyId: string
  requestedWindow: RiskWindow
  insufficientHistory: boolean
  metrics: RiskMetrics | null
  computedAt: string
}

/**
 * Fetch YieldSnapshot history for a user over a requested window and compute
 * full risk metrics (VaR, CVaR, Sortino, Drawdown, Volatility, Beta).
 */
export async function getPortfolioRiskMetrics(
  userId: string,
  window: RiskWindow = '90d',
  now: Date = new Date()
): Promise<PortfolioRiskResult> {
  const windowDays = parseRiskWindowDays(window)
  const actualDays = Math.min(windowDays, 90) // Retention boundary enforcement
  const fromDate = new Date(now.getTime() - actualDays * 24 * 60 * 60 * 1000)

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

  const buckets = new Map<number, number>()
  for (const s of snapshots) {
    const key = s.snapshotAt.getTime()
    const val = Number(s.principalAmount) + Number(s.yieldAmount)
    buckets.set(key, (buckets.get(key) ?? 0) + val)
  }

  const series: ValuePoint[] = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestampMs, value]) => ({ timestampMs, value }))

  const metrics = computeAllMetrics(series)
  const insufficientHistory = series.length < 30
  const dataFrom =
    series.length > 0 ? new Date(series[0].timestampMs).toISOString() : null
  const dataTo =
    series.length > 0
      ? new Date(series[series.length - 1].timestampMs).toISOString()
      : null

  return {
    userId,
    requestedWindow: window,
    actualWindowDays: actualDays,
    insufficientHistory,
    sampleCount: series.length,
    metrics,
    dataFrom,
    dataTo,
    computedAt: now.toISOString(),
  }
}

/** Alias used by the scheduled job. */
export const getPortfolioRisk = getPortfolioRiskMetrics

/**
 * Fetch portfolio time-series points including values, daily returns, and drawdowns.
 */
export async function getPortfolioRiskTimeseries(
  userId: string,
  window: RiskWindow = '90d',
  now: Date = new Date()
): Promise<PortfolioRiskTimeseriesResult> {
  const windowDays = parseRiskWindowDays(window)
  const actualDays = Math.min(windowDays, 90)
  const fromDate = new Date(now.getTime() - actualDays * 24 * 60 * 60 * 1000)

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

  const buckets = new Map<number, number>()
  for (const s of snapshots) {
    const key = s.snapshotAt.getTime()
    const val = Number(s.principalAmount) + Number(s.yieldAmount)
    buckets.set(key, (buckets.get(key) ?? 0) + val)
  }

  const rawSeries = Array.from(buckets.entries()).sort(([a], [b]) => a - b)

  let peak = 0
  const points = rawSeries.map(([timestampMs, portfolioValue], index) => {
    let dailyReturn: number | null = null
    if (index > 0) {
      const prevVal = rawSeries[index - 1][1]
      if (prevVal > 0) {
        dailyReturn = (portfolioValue - prevVal) / prevVal
      }
    }
    if (portfolioValue > peak) {
      peak = portfolioValue
    }
    const drawdown = peak > 0 ? (peak - portfolioValue) / peak : 0

    return {
      timestampMs,
      date: new Date(timestampMs).toISOString().split('T')[0],
      portfolioValue,
      dailyReturn,
      drawdown,
    }
  })

  return {
    userId,
    requestedWindow: window,
    points,
    computedAt: now.toISOString(),
  }
}

/**
 * Compute risk metrics for a published strategy.
 */
export async function getStrategyRiskMetrics(
  publishedStrategyId: string,
  window: RiskWindow = '90d',
  now: Date = new Date()
): Promise<StrategyRiskResult> {
  const windowDays = parseRiskWindowDays(window)
  const actualDays = Math.min(windowDays, 90)
  const fromDate = new Date(now.getTime() - actualDays * 24 * 60 * 60 * 1000)

  const snapshots = await db.yieldSnapshot.findMany({
    where: {
      OR: [
        { positionId: publishedStrategyId },
        { position: { protocolName: publishedStrategyId } },
      ],
      snapshotAt: { gte: fromDate, lte: now },
    },
    select: {
      snapshotAt: true,
      principalAmount: true,
      yieldAmount: true,
    },
    orderBy: { snapshotAt: 'asc' },
  })

  const buckets = new Map<number, number>()
  for (const s of snapshots) {
    const key = s.snapshotAt.getTime()
    const val = Number(s.principalAmount) + Number(s.yieldAmount)
    buckets.set(key, (buckets.get(key) ?? 0) + val)
  }

  const series: ValuePoint[] = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestampMs, value]) => ({ timestampMs, value }))

  const metrics = computeAllMetrics(series)
  const insufficientHistory = series.length < 30

  return {
    publishedStrategyId,
    requestedWindow: window,
    insufficientHistory,
    metrics,
    computedAt: now.toISOString(),
  }
}

// ─── Persisted aggregate helpers ─────────────────────────────────────────────

export async function getPersistedUserRisk(
  userId: string,
  window: RiskWindow
): Promise<any | null> {
  return db.portfolioRiskAggregate.findFirst({
    where: { userId, window },
    orderBy: { computedAt: 'desc' },
  })
}

export async function upsertUserRiskAggregate(
  userId: string,
  window: RiskWindow,
  data: {
    insufficientHistory: boolean
    sampleCount: number
    annualisedVolatility: number | null
    sortinoRatio: number | null
    downsideDeviation: number | null
    maxDrawdown: number | null
    maxDrawdownDuration: number | null
    varHistorical95: number | null
    varHistorical99: number | null
    varParametric95: number | null
    varParametric99: number | null
    cvarHistorical95: number | null
    cvarHistorical99: number | null
    beta: number | null
    dataFrom: Date | null
    dataTo: Date | null
  }
): Promise<void> {
  await db.portfolioRiskAggregate.upsert({
    where: { userId_window: { userId, window } },
    update: {
      ...data,
      computedAt: new Date(),
    },
    create: {
      userId,
      window,
      ...data,
      computedAt: new Date(),
    },
  })
}
