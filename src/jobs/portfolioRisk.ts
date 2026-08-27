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
 * • Operational alert via alertingService if a compute run fails after
 *   MAX_RETRIES attempts.
 * • Writes insufficientHistory: true rows rather than omitting — thin track
 *   records are visible in data but excluded from leaderboard rankings.
 * • computedAt timestamp is always surfaced so staleness is explicit.
 */

import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config/env'
import { alertingService } from '../services/alerting'
import {
  getPortfolioRisk,
  upsertUserRiskAggregate,
  type RiskWindow,
} from '../analytics/riskService'

const WINDOWS: RiskWindow[] = ['7d', '30d', '90d']
const MAX_RETRIES = 3

/** Run the full precompute pass for all active users × all windows. */
async function runPortfolioRiskPrecompute(): Promise<void> {
  const start = Date.now()
  logger.info('[PortfolioRisk] Precompute run started')

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

  const duration = Date.now() - start
  logger.info('[PortfolioRisk] Precompute run complete', {
    users: users.length,
    computations: users.length * WINDOWS.length,
    succeeded,
    failed,
    durationMs: duration,
  })
}

/**
 * Run with retry logic. Emits an operational alert after MAX_RETRIES failures.
 */
async function runWithRetry(attempt = 1): Promise<void> {
  try {
    await runPortfolioRiskPrecompute()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(
      `[PortfolioRisk] Compute run failed (attempt ${attempt}/${MAX_RETRIES})`,
      {
        error: message,
      }
    )

    if (attempt < MAX_RETRIES) {
      const delayMs = attempt * 30_000 // 30s, 60s backoff
      logger.info(`[PortfolioRisk] Retrying in ${delayMs / 1000}s...`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return runWithRetry(attempt + 1)
    }

    // Alert after exhausting retries
    await alertingService.emit({
      title: 'Portfolio Risk Precompute Failed',
      description: `All ${MAX_RETRIES} attempts failed. Last error: ${message}`,
      severity: 'warning',
      component: 'portfolio-risk-job',
      metadata: { attempts: MAX_RETRIES, lastError: message },
    })
  }
}

/**
 * Schedule the portfolio risk precompute job.
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval in gracefulShutdown.
 */
export function schedulePortfolioRiskJob(): NodeJS.Timeout {
  const intervalMs = config.portfolioRisk?.intervalMs ?? 21600000

  // Run once at startup (non-blocking)
  runWithRetry().catch((err) => {
    logger.error('[PortfolioRisk] Startup run failed unexpectedly:', err)
  })

  const handle = setInterval(() => {
    runWithRetry().catch((err) => {
      logger.error('[PortfolioRisk] Scheduled run failed unexpectedly:', err)
    })
  }, intervalMs)

  logger.info(
    `[PortfolioRisk] Job scheduled every ${intervalMs / (60 * 60 * 1000)}h`
  )
  return handle
}
