import { getPortfolioRisk } from '../analytics/riskService'
import { config } from '../config/env'
import { alertingService } from '../services/alerting'
import { logger } from '../utils/logger'
import {
  observePortfolioVolatility,
  recordVolatilityBreakerEvaluationFailure,
  recordVolatilityBreakerTrip,
  setVolatilityBreakerActivePortfolios,
} from '../utils/metrics'

const trippedUsers = new Set<string>()

export async function isPortfolioRebalanceAllowed(
  userId: string
): Promise<boolean> {
  if (!config.marketVolatilityCircuitBreaker.enabled) return true

  try {
    const result = await getPortfolioRisk(userId, '30d')
    const volatility = result.metrics?.annualisedVolatility

    if (volatility === null || volatility === undefined) {
      return !trippedUsers.has(userId)
    }

    const volatilityPct = volatility * 100
    observePortfolioVolatility(volatilityPct)

    if (volatilityPct >= config.marketVolatilityCircuitBreaker.thresholdPct) {
      if (!trippedUsers.has(userId)) {
        trippedUsers.add(userId)
        setVolatilityBreakerActivePortfolios(trippedUsers.size)
        recordVolatilityBreakerTrip()
        logger.warn('[Risk] Portfolio volatility circuit breaker opened', {
          userId,
          annualisedVolatilityPct: volatilityPct,
          thresholdPct: config.marketVolatilityCircuitBreaker.thresholdPct,
        })
        await alertingService.emit(
          {
            title: 'Portfolio volatility circuit breaker activated',
            description:
              `Rebalancing is paused for this portfolio: annualised volatility ` +
              `${volatilityPct.toFixed(2)}% exceeds the configured ` +
              `${config.marketVolatilityCircuitBreaker.thresholdPct}% threshold. ` +
              'The breaker will reset after a later risk evaluation falls below the threshold.',
            severity: 'critical',
            component: 'market-volatility-circuit-breaker',
            metadata: {
              userId,
              annualisedVolatilityPct: volatilityPct,
              thresholdPct: config.marketVolatilityCircuitBreaker.thresholdPct,
            },
          },
          `market-volatility:${userId}`
        )
      }
      return false
    }

    if (trippedUsers.delete(userId)) {
      setVolatilityBreakerActivePortfolios(trippedUsers.size)
      logger.info('[Risk] Portfolio volatility circuit breaker reset', {
        userId,
        annualisedVolatilityPct: volatilityPct,
      })
      await alertingService.emit(
        {
          title: 'Portfolio volatility circuit breaker reset',
          description:
            `Rebalancing is enabled again: annualised volatility is ` +
            `${volatilityPct.toFixed(2)}%, below the configured threshold.`,
          severity: 'info',
          component: 'market-volatility-circuit-breaker',
          metadata: { userId, annualisedVolatilityPct: volatilityPct },
        },
        `market-volatility-reset:${userId}`
      )
    }
    return true
  } catch (error) {
    trippedUsers.add(userId)
    setVolatilityBreakerActivePortfolios(trippedUsers.size)
    recordVolatilityBreakerEvaluationFailure()
    logger.error(
      '[Risk] Portfolio volatility evaluation failed; pausing rebalance',
      {
        userId,
        error: error instanceof Error ? error.message : String(error),
      }
    )
    await alertingService.emit(
      {
        title: 'Portfolio volatility could not be evaluated',
        description:
          'Rebalancing is paused for this portfolio until a risk evaluation succeeds.',
        severity: 'critical',
        component: 'market-volatility-circuit-breaker',
        metadata: { userId },
      },
      `market-volatility-evaluation:${userId}`
    )
    return false
  }
}

export function __resetVolatilityCircuitBreakerForTests(): void {
  trippedUsers.clear()
  setVolatilityBreakerActivePortfolios(0)
}
