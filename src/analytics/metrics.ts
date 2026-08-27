/**
 * src/analytics/metrics.ts
 *
 * Pure, zero-I/O risk/performance analytics engine.
 *
 * CONTRACT
 * ─────────
 * • All functions accept plain number arrays and return numbers or null.
 * • Degenerate cases (empty series, zero variance, insufficient samples,
 *   starting value ≤ 0) ALWAYS return null — never 0, Infinity, or NaN.
 * • No database access, no side-effects, no randomness — fully unit-testable
 *   with fixture series.
 *
 * ANNUALISATION
 * ─────────────
 * Uses median inter-observation spacing to be robust to snapshot gaps and
 * missed cron runs. The same algorithm lives here as the single canonical
 * definition; strategyMetrics.ts MUST import inferPeriodsPerYear from here.
 *
 * VaR / CVaR ESTIMATORS
 * ─────────────────────
 * Two distinct estimators are provided and clearly labelled:
 *   • Historical (plain-historical): sorts the empirical return distribution.
 *   • Parametric (normal): uses sample mean + σ with a Gaussian assumption.
 * Both are documented; callers must choose knowingly.
 */

export type RiskWindow = '7d' | '30d' | '60d' | '90d'

export function parseRiskWindowDays(window: RiskWindow): number {
  switch (window) {
    case '7d':
      return 7
    case '30d':
      return 30
    case '60d':
      return 60
    case '90d':
      return 90
    default:
      return 90
  }
}

/** A timestamped portfolio value observation. */
export interface ValuePoint {
  /** UTC epoch milliseconds */
  timestampMs: number
  /** Total portfolio value (principal + yield), must be > 0 to be useful */
  value: number
}

/** Returned by computeAllMetrics */
export interface RiskMetrics {
  /** Number of period-return observations used in all computations */
  sampleCount: number
  /** Earliest snapshot used (epoch ms) */
  windowStartMs: number
  /** Latest snapshot used (epoch ms) */
  windowEndMs: number
  /** Annualised volatility (σ × √periodsPerYear). null if < 2 returns. */
  annualisedVolatility: number | null
  /** Annualised Sortino ratio. null if downside deviation is 0 or no returns. */
  sortinoRatio: number | null
  /** Downside deviation (annualised). null if no returns. */
  downsideDeviation: number | null
  /** Max drawdown as a positive fraction (0.15 = 15% loss). null if no data. */
  maxDrawdown: number | null
  /** Number of periods in the maximum drawdown episode. null if no drawdown. */
  maxDrawdownDuration: number | null
  /** Historical VaR at 95% confidence (positive number = potential loss). null if < 2 returns. */
  varHistorical95: number | null
  /** Historical VaR at 99% confidence. null if < 2 returns. */
  varHistorical99: number | null
  /** Parametric VaR at 95% (Gaussian, positive = potential loss). null if zero variance. */
  varParametric95: number | null
  /** Parametric VaR at 99%. null if zero variance. */
  varParametric99: number | null
  /** Historical CVaR (Expected Shortfall) at 95%. null if < 2 returns. */
  cvarHistorical95: number | null
  /** Historical CVaR at 99%. null if < 2 returns. */
  cvarHistorical99: number | null
  /** Beta vs an exogenous benchmark series. null if benchmark not provided or degenerate. */
  beta: number | null
  /** Inferred periods-per-year used for annualisation */
  periodsPerYear: number
}

// ─── Minimum sample thresholds ────────────────────────────────────────────────

/** Minimum number of period-return observations to compute any metric. */
export const MIN_SAMPLES = 2

/** Minimum annualised periods needed to trust the series has meaningful length. */
export const MIN_PERIODS_PER_YEAR = 1 / 365

// ─── Core maths helpers ───────────────────────────────────────────────────────

/** Safe median of an array. Returns null for empty arrays. */
function median(arr: number[]): number | null {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Population variance. Returns null if fewer than 2 elements. */
function sampleVariance(arr: number[]): number | null {
  if (arr.length < 2) return null
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  const sumSq = arr.reduce((s, v) => s + (v - mean) ** 2, 0)
  return sumSq / (arr.length - 1)
}

/** Standard normal CDF (Abramowitz & Stegun approximation, max error 7.5e-8). */
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly =
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const base = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly
  return z >= 0 ? base : 1 - base
}

/** Inverse standard normal (Beasley–Springer–Moro approximation). */
function normalInvCDF(p: number): number {
  // Rational approximation valid for 0 < p < 1
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ]
  const pLow = 0.02425
  const pHigh = 1 - pLow

  let q: number
  let r: number

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  } else if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r +
        a[5]!) *
        q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
}

// ─── Annualisation ────────────────────────────────────────────────────────────

/**
 * Infer the number of observations per year from the median inter-observation
 * spacing of a timestamped series.
 *
 * This is the SINGLE canonical definition used everywhere in the codebase
 * (strategyMetrics.ts must import this instead of re-implementing).
 *
 * Robust to gaps in the series (missed snapshots, network downtime).
 * Returns null if fewer than 2 points are provided.
 */
export function inferPeriodsPerYear(points: ValuePoint[]): number | null {
  if (points.length < 2) return null
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i]!.timestampMs - sorted[i - 1]!.timestampMs
    if (g > 0) gaps.push(g)
  }
  if (gaps.length === 0) return null
  const medianGapMs = median(gaps)
  if (!medianGapMs || medianGapMs <= 0) return null
  const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000
  return MS_PER_YEAR / medianGapMs
}

// ─── Period returns ───────────────────────────────────────────────────────────

/**
 * Compute period returns from a portfolio-value series.
 *
 * Rules:
 * • Sort by timestamp ascending.
 * • Skip any interval whose STARTING value is ≤ 0 (deposit from empty — not a return).
 * • If the resulting return list is empty, return [].
 *
 * @param points - Array of timestamped portfolio values.
 * @returns Array of simple period returns (0.05 = 5% gain in that period).
 */
export function computePeriodReturns(points: ValuePoint[]): number[] {
  if (points.length < 2) return []
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs)
  const returns: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const curr = sorted[i]!
    // Skip intervals where the portfolio was un-funded (deposit-from-empty artefact)
    if (prev.value <= 0) continue
    returns.push((curr.value - prev.value) / prev.value)
  }
  return returns
}

// ─── Volatility ───────────────────────────────────────────────────────────────

/**
 * Annualised volatility (sample standard deviation × √periodsPerYear).
 * Returns null if fewer than MIN_SAMPLES returns.
 */
export function annualisedVolatility(
  returns: number[],
  periodsPerYear: number
): number | null {
  if (returns.length < MIN_SAMPLES) return null
  const variance = sampleVariance(returns)
  if (variance === null || variance <= 0) return null
  return Math.sqrt(variance * periodsPerYear)
}

// ─── Sortino & downside deviation ─────────────────────────────────────────────

/**
 * Downside deviation: RMS of returns below MAR, annualised.
 * Returns null if there are no returns.
 *
 * @param returns - Period return array.
 * @param mar - Minimum acceptable return per period (default 0).
 * @param periodsPerYear - For annualisation.
 */
export function downsideDeviation(
  returns: number[],
  periodsPerYear: number,
  mar = 0
): number | null {
  if (returns.length === 0) return null
  const negativeSquares = returns.map((r) => Math.min(r - mar, 0) ** 2)
  const meanNegSq = negativeSquares.reduce((s, v) => s + v, 0) / returns.length
  return Math.sqrt(meanNegSq * periodsPerYear)
}

/**
 * Sortino ratio: (mean annualised return − MAR) / annualised downside deviation.
 *
 * Returns null if:
 * • fewer than MIN_SAMPLES returns
 * • downside deviation is 0 (no losses — technically infinite Sortino, but we
 *   return null per the null-not-Infinity contract)
 *
 * @param returns - Period return array.
 * @param periodsPerYear - For annualisation.
 * @param mar - Annualised minimum acceptable return (default 0).
 */
export function sortinoRatio(
  returns: number[],
  periodsPerYear: number,
  mar = 0
): number | null {
  if (returns.length < MIN_SAMPLES) return null
  const meanReturn = returns.reduce((s, v) => s + v, 0) / returns.length
  const annualisedMean = meanReturn * periodsPerYear
  const dd = downsideDeviation(returns, periodsPerYear, mar / periodsPerYear)
  if (dd === null || dd <= 0) return null
  return (annualisedMean - mar) / dd
}

// ─── Max drawdown ─────────────────────────────────────────────────────────────

export interface DrawdownResult {
  /** Maximum drawdown as a positive fraction (0.20 = 20%). */
  maxDrawdown: number
  /** Number of VALUE POINTS (not returns) in the max drawdown episode. */
  maxDrawdownDuration: number
}

/**
 * Maximum drawdown and its duration from a portfolio-value series.
 *
 * Returns null if:
 * • fewer than 2 value points
 * • series is entirely un-funded (all values ≤ 0)
 *
 * Duration = number of value-point steps from peak to trough.
 */
export function maxDrawdownFromValues(
  points: ValuePoint[]
): DrawdownResult | null {
  if (points.length < 2) return null
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs)
  const values = sorted.map((p) => p.value)

  let peak = values[0]!
  let maxDD = 0
  let maxDuration = 0
  let peakIdx = 0

  for (let i = 1; i < values.length; i++) {
    const v = values[i]!
    if (v > peak) {
      peak = v
      peakIdx = i
    }
    const dd = (peak - v) / peak
    if (dd > maxDD) {
      maxDD = dd
      maxDuration = i - peakIdx
    }
  }

  if (maxDD === 0) {
    // Monotonically increasing series — no drawdown
    return { maxDrawdown: 0, maxDrawdownDuration: 0 }
  }

  return { maxDrawdown: maxDD, maxDrawdownDuration: maxDuration }
}

// ─── Rolling volatility (timeseries) ─────────────────────────────────────────

export interface RollingVolPoint {
  /** Epoch ms of the LAST return in the window */
  timestampMs: number
  /** Annualised volatility over the window. null if insufficient window data. */
  volatility: number | null
}

/**
 * Rolling annualised volatility over a sliding window of `windowSize` returns.
 *
 * @param returns - Period return array (already sorted ascending by time).
 * @param timestamps - Timestamps corresponding to the END of each return period.
 * @param windowSize - Number of returns per window.
 * @param periodsPerYear - For annualisation.
 */
export function rollingVolatility(
  returns: number[],
  timestamps: number[],
  windowSize: number,
  periodsPerYear: number
): RollingVolPoint[] {
  if (returns.length !== timestamps.length) return []
  const result: RollingVolPoint[] = []
  for (let i = 0; i < returns.length; i++) {
    if (i < windowSize - 1) {
      result.push({ timestampMs: timestamps[i]!, volatility: null })
      continue
    }
    const window = returns.slice(i - windowSize + 1, i + 1)
    result.push({
      timestampMs: timestamps[i]!,
      volatility: annualisedVolatility(window, periodsPerYear),
    })
  }
  return result
}

// ─── Rolling drawdown (timeseries) ────────────────────────────────────────────

export interface RollingDrawdownPoint {
  timestampMs: number
  /** Drawdown from local peak as a positive fraction. 0 = at all-time high. */
  drawdown: number
}

/**
 * Rolling drawdown series: drawdown from the running peak up to each point.
 */
export function rollingDrawdown(points: ValuePoint[]): RollingDrawdownPoint[] {
  if (points.length === 0) return []
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs)
  let peak = sorted[0]!.value
  return sorted.map((p) => {
    if (p.value > peak) peak = p.value
    const dd = peak > 0 ? Math.max(0, (peak - p.value) / peak) : 0
    return { timestampMs: p.timestampMs, drawdown: dd }
  })
}

// ─── Value at Risk ────────────────────────────────────────────────────────────

/**
 * Historical (empirical) VaR at a given confidence level.
 *
 * Method: sort returns ascending, take the (1−confidence) quantile.
 * Positive result = loss magnitude (sign flipped from the return).
 *
 * Returns null if fewer than MIN_SAMPLES returns.
 *
 * @param returns - Period return array.
 * @param confidence - e.g. 0.95 for 95% VaR.
 */
export function historicalVaR(
  returns: number[],
  confidence: number
): number | null {
  if (returns.length < MIN_SAMPLES) return null
  const sorted = [...returns].sort((a, b) => a - b)
  const idx = Math.floor((1 - confidence) * sorted.length)
  const varReturn = sorted[Math.max(0, idx)]!
  // VaR is a loss magnitude — negate so positive = bad
  return -varReturn
}

/**
 * Historical CVaR (Expected Shortfall) at a given confidence level.
 *
 * Method: average of all returns at or below the VaR cutoff.
 * Returns null if fewer than MIN_SAMPLES returns.
 */
export function historicalCVaR(
  returns: number[],
  confidence: number
): number | null {
  if (returns.length < MIN_SAMPLES) return null
  const sorted = [...returns].sort((a, b) => a - b)
  const cutoffIdx = Math.floor((1 - confidence) * sorted.length)
  const tail = sorted.slice(0, Math.max(1, cutoffIdx + 1))
  const avgTail = tail.reduce((s, v) => s + v, 0) / tail.length
  return -avgTail
}

/**
 * Parametric (Gaussian) VaR at a given confidence level.
 *
 * Assumes returns are normally distributed. Uses sample mean and σ.
 * Returns null if fewer than MIN_SAMPLES returns or zero variance.
 *
 * IMPORTANT: This estimator underestimates tail risk for fat-tailed
 * distributions (crypto, DeFi). Use historical VaR as the primary figure.
 */
export function parametricVaR(
  returns: number[],
  confidence: number
): number | null {
  if (returns.length < MIN_SAMPLES) return null
  const variance = sampleVariance(returns)
  if (variance === null || variance <= 0) return null
  const sigma = Math.sqrt(variance)
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length
  const z = normalInvCDF(1 - confidence)
  // VaR_parametric = -(mean + z * sigma)  where z < 0 for confidence > 0.5
  return -(mean + z * sigma)
}

// ─── Beta vs benchmark ────────────────────────────────────────────────────────

/**
 * Beta of portfolio returns vs exogenous benchmark returns.
 *
 * β = Cov(portfolio, benchmark) / Var(benchmark)
 *
 * Returns null if:
 * • series lengths differ
 * • fewer than MIN_SAMPLES observations
 * • benchmark variance is 0 (flat benchmark)
 *
 * NOTE: Benchmark data sourcing is deferred. Callers pass the benchmark
 * return series directly so the math is benchmarkagnostic.
 */
export function betaVsBenchmark(
  portfolioReturns: number[],
  benchmarkReturns: number[]
): number | null {
  if (portfolioReturns.length !== benchmarkReturns.length) return null
  if (portfolioReturns.length < MIN_SAMPLES) return null

  const n = portfolioReturns.length
  const meanP = portfolioReturns.reduce((s, v) => s + v, 0) / n
  const meanB = benchmarkReturns.reduce((s, v) => s + v, 0) / n

  let cov = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const dp = portfolioReturns[i]! - meanP
    const db = benchmarkReturns[i]! - meanB
    cov += dp * db
    varB += db * db
  }
  cov /= n - 1
  varB /= n - 1

  if (varB <= 0) return null
  return cov / varB
}

// ─── Master computation ───────────────────────────────────────────────────────

/**
 * Compute the full risk metric suite from a portfolio-value timeseries.
 *
 * @param points - Timestamped portfolio values.
 * @param benchmarkReturns - Optional exogenous benchmark return series
 *   (must be co-indexed with the portfolio returns produced internally).
 * @param mar - Annualised minimum acceptable return for Sortino (default 0).
 *
 * Returns null when the series is entirely degenerate (empty, or no funded
 * intervals).
 */
export function computeAllMetrics(
  points: ValuePoint[],
  benchmarkReturns?: number[],
  mar = 0
): RiskMetrics | null {
  if (points.length < 2) return null

  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs)
  const windowStartMs = sorted[0]!.timestampMs
  const windowEndMs = sorted[sorted.length - 1]!.timestampMs

  const periodsPerYear = inferPeriodsPerYear(sorted) ?? 365 // fallback: daily
  const returns = computePeriodReturns(sorted)
  const sampleCount = returns.length

  if (sampleCount === 0) {
    // Entirely un-funded history
    return {
      sampleCount: 0,
      windowStartMs,
      windowEndMs,
      annualisedVolatility: null,
      sortinoRatio: null,
      downsideDeviation: null,
      maxDrawdown: null,
      maxDrawdownDuration: null,
      varHistorical95: null,
      varHistorical99: null,
      varParametric95: null,
      varParametric99: null,
      cvarHistorical95: null,
      cvarHistorical99: null,
      beta: null,
      periodsPerYear,
    }
  }

  const marPerPeriod = mar / periodsPerYear
  const dd = downsideDeviation(returns, periodsPerYear, marPerPeriod)
  const drawdownResult = maxDrawdownFromValues(sorted)

  const beta =
    benchmarkReturns && benchmarkReturns.length === returns.length
      ? betaVsBenchmark(returns, benchmarkReturns)
      : null

  return {
    sampleCount,
    windowStartMs,
    windowEndMs,
    annualisedVolatility: annualisedVolatility(returns, periodsPerYear),
    sortinoRatio: sortinoRatio(returns, periodsPerYear, mar),
    downsideDeviation: dd,
    maxDrawdown: drawdownResult?.maxDrawdown ?? null,
    maxDrawdownDuration: drawdownResult?.maxDrawdownDuration ?? null,
    varHistorical95: historicalVaR(returns, 0.95),
    varHistorical99: historicalVaR(returns, 0.99),
    varParametric95: parametricVaR(returns, 0.95),
    varParametric99: parametricVaR(returns, 0.99),
    cvarHistorical95: historicalCVaR(returns, 0.95),
    cvarHistorical99: historicalCVaR(returns, 0.99),
    beta,
    periodsPerYear,
  }
}
