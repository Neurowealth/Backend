import { Prisma } from '@prisma/client'
import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { RawProtocolRatePoint } from '../agent/backtest'
import {
  AttributionResult,
  PortfolioSectorRow,
  computeAttribution,
} from '../analytics/attribution'

/**
 * Performance attribution job (#320).
 *
 * Recomputes benchmark-relative Brinson attribution for every user with
 * position history AND for every published strategy, upserting into
 * PortfolioAttribution / StrategyAttribution. All the math lives in
 * src/analytics/attribution.ts (pure + unit tested); this job is DB glue and
 * scheduling only, mirroring src/jobs/strategyMetrics.ts exactly.
 *
 * Windows are 30 and 90 days only — same retention-honesty rule as
 * strategyMetrics: src/agent/snapshotter.ts hard-deletes YieldSnapshot rows
 * past 90 days, so a longer window has no data behind it.
 *
 * Both the portfolio value series and the benchmark rate series are fetched
 * ONCE per job run (not once per user/strategy) and then sliced in memory —
 * same "one query, N in-memory windows" shape as strategyMetrics.ts, just
 * widened to "one query, ALL users" since the underlying tables are not
 * scoped to a single subject the way a single strategy's positions are.
 */

const WINDOWS = [30, 90] as const
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Names the benchmark definition + protocol subset that produced a report, so
 * a later config change never silently reinterprets an old row. See
 * config.attribution.benchmarkProtocols.
 */
function currentBenchmarkVersion(): string {
  const subset = config.attribution.benchmarkProtocols
  return `equal-weight-v1:${subset.length > 0 ? [...subset].sort().join('+') : 'all'}`
}

/** Whole-portfolio value rows for every user with position history, keyed by userId. */
async function loadPortfolioRowsByUser(
  cutoff: Date
): Promise<Map<string, PortfolioSectorRow[]>> {
  const positions = await db.position.findMany({
    select: { id: true, userId: true, protocolName: true },
  })
  const positionById = new Map(positions.map((p) => [p.id, p]))

  const snapshots = await db.yieldSnapshot.findMany({
    where: { snapshotAt: { gte: cutoff } },
    select: {
      positionId: true,
      snapshotAt: true,
      principalAmount: true,
      yieldAmount: true,
    },
  })

  const rowsByUser = new Map<string, PortfolioSectorRow[]>()
  for (const s of snapshots) {
    const position = positionById.get(s.positionId)
    if (!position) continue // orphaned snapshot (position deleted since); skip rather than guess a sector

    const rows = rowsByUser.get(position.userId) ?? []
    rows.push({
      snapshotAt: s.snapshotAt,
      sector: position.protocolName,
      value: Number(s.principalAmount) + Number(s.yieldAmount),
    })
    rowsByUser.set(position.userId, rows)
  }

  return rowsByUser
}

/** The benchmark's raw rate observations, already filtered to the configured protocol subset. */
async function loadBenchmarkRates(
  cutoff: Date
): Promise<RawProtocolRatePoint[]> {
  const subset = config.attribution.benchmarkProtocols
  const rates = await db.protocolRate.findMany({
    where: {
      fetchedAt: { gte: cutoff },
      ...(subset.length > 0 ? { protocolName: { in: subset } } : {}),
    },
    select: {
      protocolName: true,
      assetSymbol: true,
      supplyApy: true,
      fetchedAt: true,
    },
  })

  return rates.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    apy: Number(r.supplyApy),
    date: r.fetchedAt,
  }))
}

async function upsertPortfolioAttribution(
  userId: string,
  windowDays: number,
  result: AttributionResult,
  computedAt: Date
): Promise<void> {
  await db.portfolioAttribution.upsert({
    where: { userId_windowDays: { userId, windowDays } },
    create: { userId, windowDays, ...attributionRowData(result, computedAt) },
    update: attributionRowData(result, computedAt),
  })
}

async function upsertStrategyAttribution(
  publishedStrategyId: string,
  windowDays: number,
  result: AttributionResult,
  computedAt: Date
): Promise<void> {
  await db.strategyAttribution.upsert({
    where: {
      publishedStrategyId_windowDays: { publishedStrategyId, windowDays },
    },
    create: {
      publishedStrategyId,
      windowDays,
      ...attributionRowData(result, computedAt),
    },
    update: attributionRowData(result, computedAt),
  })
}

function attributionRowData(result: AttributionResult, computedAt: Date) {
  return {
    portfolioReturn: result.portfolioReturn,
    benchmarkReturn: result.benchmarkReturn,
    allocationEffect: result.allocationEffect,
    selectionEffect: result.selectionEffect,
    unattributedEffect: result.unattributedEffect,
    reconciliationGap: result.reconciliationGap,
    reconciled: result.reconciled,
    benchmarkVersion: result.benchmarkVersion,
    sectorBreakdown: result.sectors as unknown as Prisma.InputJsonValue,
    computedAt,
  }
}

export async function computePerformanceAttribution(
  now: Date = new Date()
): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'performance_attribution'

    try {
      const maxWindow = Math.max(...WINDOWS)
      const cutoff = new Date(now.getTime() - maxWindow * MS_PER_DAY)

      const [rowsByUser, benchmarkRates] = await Promise.all([
        loadPortfolioRowsByUser(cutoff),
        loadBenchmarkRates(cutoff),
      ])
      const benchmarkVersion = currentBenchmarkVersion()

      let portfoliosComputed = 0
      for (const [userId, portfolioRows] of rowsByUser) {
        for (const windowDays of WINDOWS) {
          const result = computeAttribution({
            portfolioRows,
            benchmarkRates,
            windowDays,
            now,
            benchmarkVersion,
          })
          await upsertPortfolioAttribution(userId, windowDays, result, now)
        }
        portfoliosComputed++
      }

      const strategies = await db.publishedStrategy.findMany({
        select: { id: true, userId: true },
      })

      let strategiesComputed = 0
      for (const strategy of strategies) {
        const portfolioRows = rowsByUser.get(strategy.userId) ?? []
        for (const windowDays of WINDOWS) {
          const result = computeAttribution({
            portfolioRows,
            benchmarkRates,
            windowDays,
            now,
            benchmarkVersion,
          })
          await upsertStrategyAttribution(strategy.id, windowDays, result, now)
        }
        strategiesComputed++
      }

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        portfoliosComputed,
        strategiesComputed,
      })
      recordBackgroundJob(jobName, 'success', duration)
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
      })
      recordBackgroundJob(jobName, 'failed', duration)
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Schedule the attribution job. Runs once on startup then on the configured
 * interval (default 6 h, matching strategyMarketplace).
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleAttribution(): NodeJS.Timeout {
  void computePerformanceAttribution()

  const intervalMs = config.attribution.intervalMs
  const handle = setInterval(() => {
    void computePerformanceAttribution()
  }, intervalMs)

  handle.unref?.()

  logger.info(
    `[Attribution] Performance attribution scheduled every ${intervalMs / 3600000}h`
  )
  return handle
}
