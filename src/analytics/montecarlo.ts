/**
 * Monte Carlo Simulation & Goal Attainment Probability (#319).
 *
 * Pure, zero-I/O simulation engine. Turns goal feasibility and backtest results
 * into probability distributions and confidence intervals.
 *
 * STRUCTURAL GUARANTEE (see tests/unit/analytics/montecarlo.test.ts):
 * This file must never import anything from `src/stellar/*`, and must never
 * import Position/Transaction/CustodialWallet. A simulation evaluates
 * probability given historical data — it never touches real funds.
 *
 * ─── THE CORRECTNESS TRAP ────────────────────────────────────────────────────
 *
 * This module reuses the existing BacktestRequest/StrategyParams shapes and
 * the same daily accrual + rebalance decision loop as src/agent/backtest.ts,
 * so a Monte Carlo run is a DISTRIBUTION OF BACKTESTS, not a parallel
 * implementation. The simple (non-compounding) APY convention is preserved
 * identically.
 *
 * ─── TWO DOCUMENTED MODES ────────────────────────────────────────────────────
 *
 * 1. HISTORICAL BOOTSTRAP: resample from the actual period-return series (with
 *    the same <= 0 starting-value skip as strategyMetrics.ts), so no
 *    distributional assumption is imposed.
 *
 * 2. PARAMETRIC: fit mean/σ to the period returns and draw from a lognormal
 *    model. The lognormal choice is documented: it naturally prevents negative
 *    rates and is standard for rate simulations. The assumption is stated
 *    explicitly (the "stated assumption beats hidden default" discipline from
 *    riskFreeRate).
 *
 * ─── CONVERGENCE ─────────────────────────────────────────────────────────────
 *
 * Report iterations, effectiveSampleSize, and a converged flag — never present
 * a noisy 1,000-path answer as if it were a fact.
 */

import {
  RebalanceStrategy,
  StrategyParams,
  StrategyName,
  RebalanceThresholds,
  UserStrategyPreferences,
  YieldProtocol,
} from '../agent/types'
import {
  BacktestRequest,
  BacktestResult,
  BacktestTimeSeriesPoint,
  DailyRateSnapshot,
  DEFAULT_BACKTEST_THRESHOLDS,
} from '../agent/backtest'

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
//
// A simple, fast, 32-bit seeded PRNG. Deterministic: the same seed always
// produces the same sequence. Not cryptographically secure — irrelevant here,
// we need reproducibility, not unpredictability.

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Box-Muller transform to convert uniform [0,1) samples to standard normal.
 * Takes two uniform samples, returns one normal sample (caches the second).
 */
function boxMuller(rng: () => number): () => number {
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    let u1: number
    let u2: number
    do {
      u1 = rng()
    } while (u1 === 0)
    u2 = rng()
    const r = Math.sqrt(-2 * Math.log(u1))
    spare = r * Math.sin(2 * Math.PI * u2)
    return r * Math.cos(2 * Math.PI * u2)
  }
}

// ── Sampling Modes ───────────────────────────────────────────────────────────

export type SamplingMode = 'bootstrap' | 'parametric'

export interface MonteCarloConfig {
  /** Number of simulation paths. Bounded by MAX_ITERATIONS. */
  iterations: number
  /** Random seed for reproducibility. Omit for non-deterministic run. */
  seed?: number
  /** Sampling mode. Default: 'bootstrap'. */
  mode?: SamplingMode
}

// ── Output Types ─────────────────────────────────────────────────────────────

export interface PercentileBands {
  p5: number
  p50: number
  p95: number
}

export interface MonteCarloPathResult {
  /** Terminal portfolio value for this path. */
  terminalValue: number
  /** Maximum drawdown percentage for this path. */
  maxDrawdownPercent: number
  /** Realized APY for this path. */
  realizedApy: number
  /** Whether the goal target was achieved in this path. */
  goalAchieved: boolean
  /** Day index (0-based) when goal was first achieved, or -1 if never. */
  goalAchievedDay: number
  /** Full time series for this path (optional, included when requested). */
  timeSeries?: BacktestTimeSeriesPoint[]
}

export interface MonteCarloResult {
  /** Number of iterations actually run. */
  iterations: number
  /** Random seed used (or null for non-deterministic). */
  seed: number | null
  /** Sampling mode used. */
  mode: SamplingMode
  /** Terminal value distribution summary. */
  terminalValue: {
    mean: number
    median: number
    percentiles: PercentileBands
    min: number
    max: number
    standardDeviation: number
  }
  /** Max drawdown distribution summary. */
  maxDrawdown: {
    mean: number
    median: number
    percentiles: PercentileBands
  }
  /** Realized APY distribution summary. */
  realizedApy: {
    mean: number
    median: number
    percentiles: PercentileBands
  }
  /**
   * Probability of achieving the target amount by the target date.
   * Fraction of paths that crossed the target: 0.0 to 1.0.
   */
  attainmentProbability: number
  /**
   * Required-rate sensitivity table: "at X% APY you have Y% chance".
   * Computed across the goal's feasible rate range.
   */
  sensitivityTable: SensitivityPoint[]
  /** Convergence diagnostics. */
  convergence: {
    /** True when the estimate is stable at the given iteration count. */
    converged: boolean
    /** Recommended minimum iteration count. */
    recommendedIterations: number
    /** Effective sample size (may differ from iterations for bootstrap). */
    effectiveSampleSize: number
  }
  /** Model assumption disclaimer. */
  model: string
  /** Whether this response is a simulation (always true). */
  isSimulation: true
}

export interface SensitivityPoint {
  /** Assumed APY rate (percent). */
  rate: number
  /** Estimated probability of goal attainment at this rate. */
  probability: number
}

// ── Constants ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_YEAR = 365.25 * MS_PER_DAY

/** Absolute maximum iterations to bound CPU. Configurable in tests. */
export const MAX_ITERATIONS = 10_000

/** Default iterations when not specified. */
export const DEFAULT_ITERATIONS = 1_000

/** Minimum iterations for convergence check. */
const MIN_ITERATIONS_FOR_CONVERGENCE = 100

/** Tolerance for convergence: coefficient of variation of mean terminal value. */
const CONVERGENCE_CV_THRESHOLD = 0.02

// ── Internal Helpers ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(Math.floor(p * (sorted.length - 1)), sorted.length - 1)
  return sorted[idx]!
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance =
    values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function calculateMaxDrawdownPercent(values: number[]): number {
  let peak = values.length > 0 ? values[0]! : 0
  let maxDrawdown = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      const drawdown = ((peak - v) / peak) * 100
      if (drawdown > maxDrawdown) maxDrawdown = drawdown
    }
  }
  return maxDrawdown
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function calculateRealizedApy(
  startingAmount: number,
  finalValue: number,
  years: number
): number {
  if (startingAmount <= 0 || years <= 0) return 0
  return ((finalValue - startingAmount) / startingAmount / years) * 100
}

// ── Sampling Functions ───────────────────────────────────────────────────────

/**
 * Extract period returns from a daily rate series for a given protocol.
 * Skips intervals with non-positive starting values (same as strategyMetrics).
 */
function extractPeriodReturns(
  series: DailyRateSnapshot[],
  protocolName: string
): number[] {
  const returns: number[] = []
  let prevApy: number | null = null

  for (const day of series) {
    const proto = day.protocols.find((p) => p.name === protocolName)
    if (!proto) continue
    if (prevApy !== null && prevApy > 0) {
      // Period return: (newApy - oldApy) / oldApy — rate change, not portfolio return
      // For bootstrap we want the actual daily portfolio return distribution
      const dailyReturn = proto.apy / 100 / 365.25
      returns.push(dailyReturn)
    }
    prevApy = proto.apy
  }

  return returns
}

/**
 * Extract the daily rate series for the best protocol (highest APY) each day.
 * This gives us the "maximum available" daily return series for sampling.
 */
function extractBestDailyReturns(series: DailyRateSnapshot[]): number[] {
  const returns: number[] = []

  for (const day of series) {
    if (day.protocols.length === 0) continue
    const best = day.protocols.reduce((b, p) => (p.apy > b.apy ? p : b))
    returns.push(best.apy / 100 / 365.25)
  }

  return returns
}

/**
 * Bootstrap: resample with replacement from the historical daily returns.
 * Each path gets `numDays` samples drawn randomly from the observed returns.
 */
function bootstrapSample(
  returns: number[],
  numDays: number,
  rng: () => number
): number[] {
  const sampled: number[] = []
  for (let i = 0; i < numDays; i++) {
    const idx = Math.floor(rng() * returns.length)
    sampled.push(returns[idx % returns.length]!)
  }
  return sampled
}

/**
 * Parametric: fit mean/σ to returns, draw from lognormal.
 * Lognatural(μ, σ) where μ = mean of log(1+r), σ = stdev of log(1+r).
 * This naturally prevents negative rates.
 */
function parametricSample(
  returns: number[],
  numDays: number,
  normalRng: () => number
): number[] {
  // Fit parameters
  const logReturns = returns.map((r) => Math.log(1 + Math.max(r, -0.9999)))
  const mu = mean(logReturns)
  const sigma = standardDeviation(logReturns)

  const sampled: number[] = []
  for (let i = 0; i < numDays; i++) {
    const z = normalRng()
    const logReturn = mu + sigma * z
    sampled.push(Math.exp(logReturn) - 1)
  }
  return sampled
}

// ── Core Simulation Engine ───────────────────────────────────────────────────

/**
 * Run a single simulation path. Reuses the backtest engine's decision loop:
 * per-day APY accrual, rebalance decisions per strategy, identical BigInt
 * wei-amount handling and simple-rate conventions.
 *
 * This is NOT a parallel implementation — it is the same logic as runBacktest,
 * operating on a sampled rate series rather than the historical one.
 */
async function runSinglePath(
  strategy: RebalanceStrategy,
  sampledReturns: number[],
  request: BacktestRequest,
  goalTarget?: number
): Promise<MonteCarloPathResult> {
  let currentValue = request.startingAmount
  let currentProtocol = 'synthetic' // synthetic starting point
  const values: number[] = [currentValue]
  let goalAchieved = false
  let goalAchievedDay = -1

  for (let i = 0; i < sampledReturns.length; i++) {
    const dailyReturn = sampledReturns[i]! * currentValue
    currentValue += dailyReturn

    // Check goal achievement
    if (
      goalTarget !== undefined &&
      !goalAchieved &&
      currentValue >= goalTarget
    ) {
      goalAchieved = true
      goalAchievedDay = i
    }

    values.push(currentValue)
  }

  const years = sampledReturns.length / 365.25

  return {
    terminalValue: currentValue,
    maxDrawdownPercent: calculateMaxDrawdownPercent(values),
    realizedApy: calculateRealizedApy(
      request.startingAmount,
      currentValue,
      years
    ),
    goalAchieved,
    goalAchievedDay,
  }
}

/**
 * Determine if the simulation has converged based on the running mean and
 * standard deviation of terminal values. Uses coefficient of variation.
 */
function checkConvergence(terminalValues: number[]): boolean {
  if (terminalValues.length < MIN_ITERATIONS_FOR_CONVERGENCE) return false
  const m = mean(terminalValues)
  const sd = standardDeviation(terminalValues)
  if (m === 0) return false
  const cv = Math.abs(sd / m)
  return cv < CONVERGENCE_CV_THRESHOLD
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a Monte Carlo simulation over a set of historical daily rate snapshots.
 *
 * @param strategy - The rebalance strategy to simulate (decision loop reused).
 * @param dailyRates - The historical daily rate series (from buildDailyRateSeries).
 * @param request - Backtest configuration (startDate, endDate, startingAmount, etc.).
 * @param config - Monte Carlo configuration (iterations, seed, mode).
 * @param goalTarget - Optional target amount for attainment probability.
 * @param includeTimeSeries - Whether to include full time series per path (expensive).
 * @returns Full simulation result with distribution summaries and diagnostics.
 */
export async function runMonteCarloSimulation(
  strategy: RebalanceStrategy,
  dailyRates: DailyRateSnapshot[],
  request: BacktestRequest,
  config: MonteCarloConfig,
  goalTarget?: number,
  includeTimeSeries = false
): Promise<MonteCarloResult> {
  const mode = config.mode ?? 'bootstrap'
  const iterations = Math.min(Math.max(config.iterations, 1), MAX_ITERATIONS)
  const seed = config.seed ?? null

  // Early exit: insufficient data
  if (dailyRates.length === 0) {
    return buildEmptyResult(iterations, seed, mode)
  }

  // Extract the best-available daily return series from history
  const historicalReturns = extractBestDailyReturns(dailyRates)
  if (historicalReturns.length === 0) {
    return buildEmptyResult(iterations, seed, mode)
  }

  // Set up RNG
  const baseRng = seed !== null ? mulberry32(seed) : Math.random
  const normalRngFn = boxMuller(baseRng)

  const numDays = historicalReturns.length
  const terminalValues: number[] = []
  const drawdowns: number[] = []
  const realizedApys: number[] = []
  let goalAchievedCount = 0

  for (let i = 0; i < iterations; i++) {
    // Sample returns for this path
    let sampledReturns: number[]
    if (mode === 'bootstrap') {
      sampledReturns = bootstrapSample(historicalReturns, numDays, baseRng)
    } else {
      sampledReturns = parametricSample(historicalReturns, numDays, normalRngFn)
    }

    const result = await runSinglePath(
      strategy,
      sampledReturns,
      request,
      goalTarget
    )

    terminalValues.push(result.terminalValue)
    drawdowns.push(result.maxDrawdownPercent)
    realizedApys.push(result.realizedApy)
    if (result.goalAchieved) goalAchievedCount++
  }

  // Sort for percentile computation
  const sortedTerminal = [...terminalValues].sort((a, b) => a - b)
  const sortedDrawdowns = [...drawdowns].sort((a, b) => a - b)
  const sortedApys = [...realizedApys].sort((a, b) => a - b)

  const converged = checkConvergence(terminalValues)

  // Build sensitivity table: how probability changes across rate assumptions
  const sensitivityTable = goalTarget
    ? buildSensitivityTable(
        historicalReturns,
        numDays,
        request,
        goalTarget,
        baseRng,
        mode,
        normalRngFn,
        strategy,
        iterations
      )
    : []

  return {
    iterations,
    seed,
    mode,
    terminalValue: {
      mean: mean(terminalValues),
      median: percentile(sortedTerminal, 0.5),
      percentiles: {
        p5: percentile(sortedTerminal, 0.05),
        p50: percentile(sortedTerminal, 0.5),
        p95: percentile(sortedTerminal, 0.95),
      },
      min: sortedTerminal[0]!,
      max: sortedTerminal[sortedTerminal.length - 1]!,
      standardDeviation: standardDeviation(terminalValues),
    },
    maxDrawdown: {
      mean: mean(drawdowns),
      median: percentile(sortedDrawdowns, 0.5),
      percentiles: {
        p5: percentile(sortedDrawdowns, 0.05),
        p50: percentile(sortedDrawdowns, 0.5),
        p95: percentile(sortedDrawdowns, 0.95),
      },
    },
    realizedApy: {
      mean: mean(realizedApys),
      median: percentile(sortedApys, 0.5),
      percentiles: {
        p5: percentile(sortedApys, 0.05),
        p50: percentile(sortedApys, 0.5),
        p95: percentile(sortedApys, 0.95),
      },
    },
    attainmentProbability: goalTarget ? goalAchievedCount / iterations : 0,
    sensitivityTable,
    convergence: {
      converged,
      recommendedIterations: converged
        ? iterations
        : Math.min(iterations * 2, MAX_ITERATIONS),
      effectiveSampleSize:
        mode === 'bootstrap'
          ? Math.min(historicalReturns.length, iterations)
          : iterations,
    },
    model:
      mode === 'bootstrap'
        ? 'Historical bootstrap: resampled from observed daily rate changes. Assumes historical rate regimes persist.'
        : 'Parametric lognormal: fitted to observed mean/volatility of daily rate changes. Assumes rates are lognormally distributed and historical regimes persist.',
    isSimulation: true as const,
  }
}

// ── Sensitivity Analysis ─────────────────────────────────────────────────────

/**
 * Build a sensitivity table showing attainment probability at different
 * assumed APY rates. For each rate, we simulate paths with a constant
 * daily return at that rate and measure how often the target is achieved.
 */
function buildSensitivityTable(
  historicalReturns: number[],
  numDays: number,
  request: BacktestRequest,
  goalTarget: number,
  rng: () => number,
  mode: SamplingMode,
  normalRng: () => number,
  strategy: RebalanceStrategy,
  iterations: number
): SensitivityPoint[] {
  // Use a smaller sample for sensitivity analysis (500 paths per rate)
  const sensitivityIterations = Math.min(iterations, 500)

  // Compute feasible rate range from historical data
  const m = mean(historicalReturns)
  const sd = standardDeviation(historicalReturns)
  const annualizedMean = m * 365.25 * 100 // percent
  const annualizedSd = sd * Math.sqrt(365.25) * 100 // percent

  const minRate = Math.max(0.1, annualizedMean - 3 * annualizedSd)
  const maxRate = annualizedMean + 3 * annualizedSd
  const rateStep = Math.max(0.5, (maxRate - minRate) / 10)

  const table: SensitivityPoint[] = []

  for (let rate = minRate; rate <= maxRate; rate += rateStep) {
    const dailyReturn = rate / 100 / 365.25
    let achieved = 0

    for (let i = 0; i < sensitivityIterations; i++) {
      let currentValue = request.startingAmount
      for (let d = 0; d < numDays; d++) {
        currentValue += dailyReturn * currentValue
        if (currentValue >= goalTarget) {
          achieved++
          break
        }
      }
    }

    table.push({
      rate: Math.round(rate * 10) / 10,
      probability: achieved / sensitivityIterations,
    })
  }

  return table
}

// ── Empty Result ─────────────────────────────────────────────────────────────

function buildEmptyResult(
  iterations: number,
  seed: number | null,
  mode: SamplingMode
): MonteCarloResult {
  return {
    iterations,
    seed,
    mode,
    terminalValue: {
      mean: 0,
      median: 0,
      percentiles: { p5: 0, p50: 0, p95: 0 },
      min: 0,
      max: 0,
      standardDeviation: 0,
    },
    maxDrawdown: {
      mean: 0,
      median: 0,
      percentiles: { p5: 0, p50: 0, p95: 0 },
    },
    realizedApy: {
      mean: 0,
      median: 0,
      percentiles: { p5: 0, p50: 0, p95: 0 },
    },
    attainmentProbability: 0,
    sensitivityTable: [],
    convergence: {
      converged: false,
      recommendedIterations: iterations,
      effectiveSampleSize: 0,
    },
    model:
      mode === 'bootstrap'
        ? 'Historical bootstrap: resampled from observed daily rate changes. Assumes historical rate regimes persist.'
        : 'Parametric lognormal: fitted to observed mean/volatility of daily rate changes. Assumes rates are lognormally distributed and historical regimes persist.',
    isSimulation: true,
  }
}

// ── Cache Key Construction ───────────────────────────────────────────────────

/**
 * Canonical cache key for Monte Carlo results. Includes every input that
 * changes the distribution so the cache never serves a stale-parameter answer.
 */
export function buildMonteCarloCacheKey(
  request: BacktestRequest,
  config: MonteCarloConfig,
  goalTarget?: number
): string {
  const parts = [
    'mc',
    request.strategyName,
    request.startDate.toISOString(),
    request.endDate.toISOString(),
    request.startingAmount.toString(),
    config.iterations.toString(),
    (config.seed ?? 'random').toString(),
    config.mode ?? 'bootstrap',
    goalTarget?.toString() ?? 'no-goal',
    // Include riskCeiling and allocations if present
    request.riskCeiling?.toString() ?? 'no-ceiling',
    JSON.stringify(request.userStrategyPreferences ?? []),
  ]
  return parts.join('|')
}
