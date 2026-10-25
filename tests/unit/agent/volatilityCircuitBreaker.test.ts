jest.mock('../../../src/config/env', () => ({
  config: {
    marketVolatilityCircuitBreaker: { enabled: true, thresholdPct: 75 },
  },
}))

jest.mock('../../../src/analytics/riskService', () => ({
  getPortfolioRisk: jest.fn(),
}))

jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/utils/metrics', () => ({
  observePortfolioVolatility: jest.fn(),
  recordVolatilityBreakerEvaluationFailure: jest.fn(),
  recordVolatilityBreakerTrip: jest.fn(),
  setVolatilityBreakerActivePortfolios: jest.fn(),
}))

import { getPortfolioRisk } from '../../../src/analytics/riskService'
import { alertingService } from '../../../src/services/alerting'
import {
  __resetVolatilityCircuitBreakerForTests,
  isPortfolioRebalanceAllowed,
} from '../../../src/agent/volatilityCircuitBreaker'
import {
  recordVolatilityBreakerEvaluationFailure,
  recordVolatilityBreakerTrip,
  setVolatilityBreakerActivePortfolios,
} from '../../../src/utils/metrics'

const mockGetPortfolioRisk = getPortfolioRisk as jest.Mock
const mockEmit = alertingService.emit as jest.Mock

function risk(annualisedVolatility: number | null) {
  return { metrics: { annualisedVolatility } }
}

describe('market volatility circuit breaker', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetVolatilityCircuitBreakerForTests()
  })

  it('blocks rebalance and alerts once when volatility reaches the threshold', async () => {
    mockGetPortfolioRisk.mockResolvedValue(risk(0.75))

    await expect(isPortfolioRebalanceAllowed('user-1')).resolves.toBe(false)
    await expect(isPortfolioRebalanceAllowed('user-1')).resolves.toBe(false)

    expect(recordVolatilityBreakerTrip).toHaveBeenCalledTimes(1)
    expect(setVolatilityBreakerActivePortfolios).toHaveBeenLastCalledWith(1)
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit.mock.calls[0][0].metadata).toMatchObject({
      userId: 'user-1',
      thresholdPct: 75,
    })
  })

  it('resumes rebalance and alerts when volatility falls below threshold', async () => {
    mockGetPortfolioRisk
      .mockResolvedValueOnce(risk(0.8))
      .mockResolvedValueOnce(risk(0.5))

    await expect(isPortfolioRebalanceAllowed('user-1')).resolves.toBe(false)
    await expect(isPortfolioRebalanceAllowed('user-1')).resolves.toBe(true)

    expect(mockEmit).toHaveBeenCalledTimes(2)
    expect(mockEmit.mock.calls[1][0].title).toContain('reset')
    expect(setVolatilityBreakerActivePortfolios).toHaveBeenLastCalledWith(0)
  })

  it('fails closed and emits an operator alert when risk evaluation fails', async () => {
    mockGetPortfolioRisk.mockRejectedValue(new Error('database unavailable'))

    await expect(isPortfolioRebalanceAllowed('user-1')).resolves.toBe(false)

    expect(recordVolatilityBreakerEvaluationFailure).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Portfolio volatility could not be evaluated',
        severity: 'critical',
      }),
      'market-volatility-evaluation:user-1'
    )
  })

  it('does not clear an open breaker when volatility data is unavailable', async () => {
    mockGetPortfolioRisk
      .mockResolvedValueOnce(risk(0.8))
      .mockResolvedValueOnce(risk(null))

    await isPortfolioRebalanceAllowed('user-1')
    await expect(isPortfolioRebalanceAllowed('user-1')).resolves.toBe(false)
    expect(mockEmit).toHaveBeenCalledTimes(1)
  })
})
