import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import {
  bucketByInstant,
  computeStrategyMetrics,
  SnapshotRow,
} from '../agent/strategyMetrics'

/**
 * Strategy marketplace metrics job (#285).
 *
 * Recomputes each published strategy's leaderboard figures from its publisher's
 * YieldSnapshot history and upserts them into PublishedStrategyMetric. All the
 * math lives in src/agent/strategyMetrics.ts (pure + unit tested); this job is
 * only DB glue and scheduling, mirroring src/jobs/protocolRiskScoring.ts.
 *
 * Why precompute at all: the leaderboard sorts on a risk-adjusted score with
 * skip/take, which has to happen in SQL, and recomputing every publisher's
 * 90-day snapshot history per request would turn a semi-public endpoint into a
 * DoS vector.
 *
 * Windows are 30 and 90 days only — snapshotter.cleanupOldSnapshots hard-deletes
 * YieldSnapshot rows past 90 days, so anything longer has no data behind it.
 * Both windows come out of ONE 90-day query per strategy; the 30-day series is
 * a filter over the same rows.
 *
 * Metrics are computed for unpublished strategies too, so re-publishing is
 * ranked immediately instead of waiting up to a full interval for a cold start.
 * The marketplace query, not this job, applies the isPublished filter.
 */

const WINDOWS = [30, 90] as const

const MS_PER_DAY = 24 * 60 * 60 * 1000

export async function computeStrategyMarketplaceMetrics(
  now: Date = new Date()
): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const startTime = Date.now()
    const jobName = 'strategy_metrics'

    try {
      const strategies = await db.publishedStrategy.findMany({
        select: { id: true, userId: true },
      })

      let computed = 0

      for (const strategy of strategies) {
        const positions = await db.position.findMany({
          where: { userId: strategy.userId },
          select: { id: true },
        })

        const positionIds = positions.map((p) => p.id)

        // No positions means no portfolio series and therefore no computable
        // metrics. Write ineligible rows rather than leaving stale ones behind:
        // a publisher who closed everything must drop off the board, not keep
        // last week's numbers.
        if (positionIds.length === 0) {
          for (const windowDays of WINDOWS) {
            await upsertMetric(strategy.id, windowDays, {
              apy: 0,
              sharpe: null,
              sampleCount: 0,
              trackRecordDays: 0,
              isEligible: false,
              computedAt: now,
            })
          }
          computed++
          continue
        }

        const earliest = await db.yieldSnapshot.findFirst({
          where: { positionId: { in: positionIds } },
          orderBy: { snapshotAt: 'asc' },
          select: { snapshotAt: true },
        })

        const maxWindow = Math.max(...WINDOWS)
        const cutoff = new Date(now.getTime() - maxWindow * MS_PER_DAY)

        const snapshots = await db.yieldSnapshot.findMany({
          where: {
            positionId: { in: positionIds },
            snapshotAt: { gte: cutoff },
          },
          select: {
            snapshotAt: true,
            principalAmount: true,
            yieldAmount: true,
          },
        })

        const rows: SnapshotRow[] = snapshots.map((s) => ({
          snapshotAt: s.snapshotAt,
          principalAmount: Number(s.principalAmount),
          yieldAmount: Number(s.yieldAmount),
        }))

        for (const windowDays of WINDOWS) {
          const windowCutoff = new Date(now.getTime() - windowDays * MS_PER_DAY)
          const points = bucketByInstant(
            rows.filter((r) => r.snapshotAt >= windowCutoff)
          )

          const metrics = computeStrategyMetrics({
            points,
            firstObservedAt: earliest?.snapshotAt ?? null,
            now,
            riskFreeRate: config.strategyMarketplace.riskFreeRate,
          })

          await upsertMetric(strategy.id, windowDays, {
            ...metrics,
            computedAt: now,
          })
        }

        computed++
      }

      const durationMs = Date.now() - startTime
      const duration = durationMs / 1000

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        strategiesComputed: computed,
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

async function upsertMetric(
  publishedStrategyId: string,
  windowDays: number,
  data: {
    apy: number
    sharpe: number | null
    sampleCount: number
    trackRecordDays: number
    isEligible: boolean
    computedAt: Date
  }
): Promise<void> {
  await db.publishedStrategyMetric.upsert({
    where: {
      publishedStrategyId_windowDays: { publishedStrategyId, windowDays },
    },
    create: { publishedStrategyId, windowDays, ...data },
    update: data,
  })
}

/**
 * Schedule the marketplace metrics job. Runs once on startup then on the
 * configured interval (default 6 h, matching protocolRisk).
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleStrategyMetrics(): NodeJS.Timeout {
  void computeStrategyMarketplaceMetrics()

  const intervalMs = config.strategyMarketplace.metricsIntervalMs
  const handle = setInterval(() => {
    void computeStrategyMarketplaceMetrics()
  }, intervalMs)

  handle.unref?.()

  logger.info(
    `[StrategyMetrics] Marketplace metrics scheduled every ${intervalMs / 3600000}h`
  )
  return handle
}
