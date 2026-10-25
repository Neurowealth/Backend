/**
 * src/jobs/portfolioRisk.ts
 *
 * Scheduled job that precomputes per-user portfolio risk metrics and persists
 * them into portfolio_risk_aggregates so leaderboards can ORDER BY in SQL
 * without recomputing on every request.
 *
 * Design mirrors the pattern established by sessionCleanup.ts:
 * • Exported schedule function returns a handle for gracefulShutdown to clear.
 * • Configurable interval via PORTFOLIO_RISK_INTERVAL_HOURS (default: 6).
 * • Operational alert via alertingService if a compute run still fails after
 *   the shared scheduler exhausts its backoff retries.
 * • Writes insufficientHistory: true rows rather than omitting — thin track
 *   records are visible in data but excluded from leaderboard rankings.
 * • computedAt timestamp is always surfaced so staleness is explicit.
 */

import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config/env'
import { alertingService } from '../services/alerting'
import { recordBackgroundJob } from '../utils/metrics'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { scheduleResilientJob } from './resilientScheduler'
import {
  getPortfolioRisk,
  upsertUserRiskAggregate,
  type RiskWindow,
} from '../analytics/riskService'

const WINDOWS: RiskWindow[] = ['7d', '30d', '90d']
const JOB_NAME = 'portfolio_risk'

/** Run the full precompute pass for all active users × all windows. */
async function runPortfolioRiskPrecompute(): Promise<void> {
  const start = Date.now()
  logger.info('[PortfolioRisk] Precompute run started')

  try {
    // Fetch all users who have at least one position (no point computing empty portfolios)
    const users = await db.user.findMany({
      where: {
        isActive: true,
        positions: { some: {} },
      },
      select: { id: true },
    })

    if (users.length === 0) {
      logger.info('[PortfolioRisk] No active users with positions — skipping')
      recordJobSuccess(JOB_NAME, Date.now() - start)
      return
    }

    let succeeded = 0
    let failed = 0

    for (const user of users) {
      for (const window of WINDOWS) {
        try {
          const result = await getPortfolioRisk(user.id, window)
          const m = result.metrics

          await upsertUserRiskAggregate(user.id, window, {
            insufficientHistory: result.insufficientHistory,
            sampleCount: m?.sampleCount ?? 0,
            annualisedVolatility: m?.annualisedVolatility ?? null,
            sortinoRatio: m?.sortinoRatio ?? null,
            downsideDeviation: m?.downsideDeviation ?? null,
            maxDrawdown: m?.maxDrawdown ?? null,
            maxDrawdownDuration: m?.maxDrawdownDuration ?? null,
            varHistorical95: m?.varHistorical95 ?? null,
            varHistorical99: m?.varHistorical99 ?? null,
            varParametric95: m?.varParametric95 ?? null,
            varParametric99: m?.varParametric99 ?? null,
            cvarHistorical95: m?.cvarHistorical95 ?? null,
            cvarHistorical99: m?.cvarHistorical99 ?? null,
            beta: m?.beta ?? null,
            dataFrom: result.dataFrom ? new Date(result.dataFrom) : null,
            dataTo: result.dataTo ? new Date(result.dataTo) : null,
          })

          succeeded++
        } catch (err) {
          failed++
          logger.error('[PortfolioRisk] Failed to precompute for user/window', {
            userId: user.id,
            window,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    const durationMs = Date.now() - start
    logger.info('[PortfolioRisk] Precompute run complete', {
      users: users.length,
      computations: users.length * WINDOWS.length,
      succeeded,
      failed,
      durationMs,
    })

    if (failed > 0) {
      throw new Error(
        `${failed} user/window precompute failure(s) out of ${succeeded + failed}`
      )
    }

    recordBackgroundJob(JOB_NAME, 'success', durationMs / 1000)
    recordJobSuccess(JOB_NAME, durationMs)
  } catch (err) {
    const durationMs = Date.now() - start
    recordBackgroundJob(JOB_NAME, 'failed', durationMs / 1000)
    recordJobFailure(JOB_NAME, durationMs, err)
  }
}

/**
 * Schedule the portfolio risk precompute job.
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval in gracefulShutdown.
 */
export function schedulePortfolioRiskJob(): NodeJS.Timeout {
  const intervalMs = config.portfolioRisk?.intervalMs ?? 21600000

  const handle = scheduleResilientJob({
    jobName: JOB_NAME,
    task: runPortfolioRiskPrecompute,
    intervalMs,
    onExhausted: async (error, attempts) => {
      const message = error instanceof Error ? error.message : String(error)
      await alertingService.emit({
        title: 'Portfolio Risk Precompute Failed',
        description: `All ${attempts} attempts failed. Last error: ${message}`,
        severity: 'warning',
        component: 'portfolio-risk-job',
        metadata: { attempts, lastError: message },
      })
    },
  })

  logger.info(
    `[PortfolioRisk] Job scheduled every ${intervalMs / (60 * 60 * 1000)}h`
  )
  return handle
}
