/**
 * Goal Simulation Service (#319) — Monte Carlo goal attainment probability.
 *
 * Resolves a user's effective strategy config, fetches historical rate data,
 * and runs the Monte Carlo engine. Owner-scoped and I/O-heavy (unlike the
 * pure montecarlo.ts core), so it lives here rather than in src/analytics/.
 */

import db from '../db'
import { logger } from '../utils/logger'
import {
  resolveEffectiveConfig,
  parseStrategyConfig,
  EffectiveStrategyConfig,
} from '../agent/effectiveStrategy'
import {
  buildDailyRateSeries,
  BacktestRequest,
  DailyRateSnapshot,
  RawProtocolRatePoint,
} from '../agent/backtest'
import {
  runMonteCarloSimulation,
  MonteCarloConfig,
  MonteCarloResult,
  buildMonteCarloCacheKey,
} from '../analytics/montecarlo'
import { cacheGet, cacheSet } from '../config/redis'
import {
  MaxYieldStrategy,
  TargetAllocationStrategy,
  GoalTrackingStrategy,
} from '../agent/strategies'
import { StrategyName, RebalanceStrategy } from '../agent/types'

const SIMULATION_CACHE_TTL = 300 // 5 minutes

export class GoalNotFoundError extends Error {}
export class GoalValidationError extends Error {}
export class InsufficientHistoryError extends Error {
  constructor(
    public earliestAvailableDate: Date | null,
    message: string
  ) {
    super(message)
    this.name = 'InsufficientHistoryError'
  }
}

export interface SimulateGoalInput {
  iterations?: number
  seed?: number
  mode?: 'bootstrap' | 'parametric'
}

/**
 * Resolve the effective strategy config for a user, incorporating any active
 * follow and the goal's own riskCeiling.
 */
async function resolveStrategyForUser(
  userId: string
): Promise<EffectiveStrategyConfig> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      rebalanceStrategy: true,
      strategyConfig: true,
    },
  })

  if (!user) {
    throw new GoalNotFoundError('User not found')
  }

  const ownConfig = parseStrategyConfig({
    strategyName: user.rebalanceStrategy,
    ...((user.strategyConfig as Record<string, unknown>) ?? {}),
  })

  // Check for active follow (unfollowedAt = null means active)
  const follow = await db.strategyFollow.findFirst({
    where: { followerUserId: userId, unfollowedAt: null },
    include: {
      publishedStrategy: {
        select: { strategyConfig: true },
      },
    },
  })

  const followedConfig = follow
    ? parseStrategyConfig((follow as any).publishedStrategy?.strategyConfig)
    : null

  return resolveEffectiveConfig(ownConfig, followedConfig)
}

/**
 * Load historical ProtocolRate data for the simulation window.
 * Uses a 90-day lookback for the bootstrap sample.
 */
async function loadHistoricalRates(
  startDate: Date,
  endDate: Date
): Promise<RawProtocolRatePoint[]> {
  const rates = await db.protocolRate.findMany({
    where: {
      fetchedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    select: {
      protocolName: true,
      assetSymbol: true,
      supplyApy: true,
      fetchedAt: true,
    },
    orderBy: { fetchedAt: 'asc' },
  })

  return rates.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    apy: Number(r.supplyApy),
    date: r.fetchedAt,
  }))
}

/**
 * Resolve the strategy instance from the effective config.
 */
function resolveStrategy(strategyName: StrategyName | null): RebalanceStrategy {
  switch (strategyName) {
    case 'TARGET_ALLOCATION':
      return new TargetAllocationStrategy()
    case 'GOAL_TRACKING':
      return new GoalTrackingStrategy()
    case 'MAX_YIELD':
    default:
      return new MaxYieldStrategy()
  }
}

/**
 * Run a Monte Carlo simulation for a savings goal.
 *
 * Returns the simulation result, or throws GoalNotFoundError /
 * InsufficientHistoryError / GoalValidationError as appropriate.
 */
export async function simulateGoal(
  goalId: string,
  userId: string,
  input: SimulateGoalInput = {}
): Promise<MonteCarloResult> {
  // 1. Fetch and validate the goal
  const goal = await db.savingsGoal.findUnique({ where: { id: goalId } })
  if (!goal) {
    throw new GoalNotFoundError('Savings goal not found')
  }
  if (goal.userId !== userId) {
    throw new GoalNotFoundError('Savings goal not found')
  }
  if (goal.status !== 'ACTIVE') {
    throw new GoalValidationError('Only an ACTIVE goal can be simulated')
  }

  const targetAmount = Number(goal.targetAmount)
  const startingAmount = Number(goal.startingAmount)

  if (startingAmount <= 0) {
    throw new GoalValidationError('Starting amount must be positive')
  }

  const targetDate = goal.targetDate
  if (targetDate.getTime() <= Date.now()) {
    throw new GoalValidationError('Target date must be in the future')
  }

  // 2. Resolve effective strategy config
  const effectiveConfig = await resolveStrategyForUser(userId)

  // Merge goal's riskCeiling with effective config (goal wins)
  const riskCeiling =
    goal.riskCeiling ?? effectiveConfig.riskCeiling ?? undefined

  // 3. Build the simulation window
  // Use 90 days before today as the start, or the earliest available data
  const now = new Date()
  const lookbackStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  // 4. Load historical rates
  const rawPoints = await loadHistoricalRates(lookbackStart, now)

  if (rawPoints.length === 0) {
    throw new InsufficientHistoryError(
      null,
      'No historical rate data available for simulation'
    )
  }

  // 5. Build daily rate series with gap handling
  const { series: dailyRates, earliestAvailableDate } = buildDailyRateSeries(
    rawPoints,
    lookbackStart,
    now
  )

  if (dailyRates.length === 0) {
    throw new InsufficientHistoryError(
      earliestAvailableDate,
      'Insufficient history to build rate series for simulation'
    )
  }

  // 6. Check cache
  const iterations = input.iterations ?? 1000
  const seed = input.seed ?? Math.floor(Math.random() * 2147483647)
  const mode = input.mode ?? 'bootstrap'

  const cacheKey = buildMonteCarloCacheKey(
    {
      strategyName: (effectiveConfig.strategyName ??
        'MAX_YIELD') as StrategyName,
      startDate: lookbackStart,
      endDate: now,
      startingAmount,
      riskCeiling,
    },
    { iterations, seed, mode },
    targetAmount
  )

  const cached = await cacheGet<MonteCarloResult>(cacheKey)
  if (cached) {
    logger.info('[Simulate] Cache hit', { goalId, userId })
    return cached
  }

  // 7. Load risk scores if needed
  let protocolRiskScores: Record<string, number> | undefined
  if (riskCeiling !== undefined) {
    const rows = await db.protocolRiskScore.findMany({
      select: { protocolName: true, score: true },
    })
    protocolRiskScores = {}
    for (const row of rows as Array<{ protocolName: string; score: number }>) {
      protocolRiskScores[row.protocolName] = row.score
    }
  }

  // 8. Load user preferences for allocation strategy
  const userPrefs = effectiveConfig.targetAllocations
    ? [
        {
          userId,
          strategyName: effectiveConfig.strategyName,
          targetAllocations: effectiveConfig.targetAllocations,
          riskCeiling: effectiveConfig.riskCeiling,
        },
      ]
    : []

  // 9. Build backtest request
  const request: BacktestRequest = {
    strategyName: (effectiveConfig.strategyName ?? 'MAX_YIELD') as StrategyName,
    startDate: lookbackStart,
    endDate: now,
    startingAmount,
    riskCeiling,
    protocolRiskScores,
    userStrategyPreferences: userPrefs,
    goal: {
      targetAmount,
      startingAmount,
      targetDate,
    },
  }

  // 10. Resolve strategy instance
  const strategy = resolveStrategy(effectiveConfig.strategyName)

  // 11. Run Monte Carlo simulation
  logger.info('[Simulate] Running simulation', {
    goalId,
    userId,
    iterations,
    seed,
    mode,
    targetAmount,
    startingAmount,
  })

  const result = await runMonteCarloSimulation(
    strategy,
    dailyRates,
    request,
    { iterations, seed, mode },
    targetAmount
  )

  // 12. Cache result
  await cacheSet(cacheKey, result, SIMULATION_CACHE_TTL)

  return result
}
