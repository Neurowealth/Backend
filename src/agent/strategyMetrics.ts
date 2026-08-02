/**
 * Strategy performance metrics — pure computation (#285).
 *
 * Turns a publisher's YieldSnapshot history into the anonymized figures the
 * marketplace leaderboard ranks on: an annualized return, a risk-adjusted
 * Sharpe ratio, and the eligibility gate that keeps thin track records off the
 * board entirely. Deliberately free of I/O so it can be unit tested against
 * fixture series; src/jobs/strategyMetrics.ts is the only thing that reads the
 * DB and calls in here, mirroring riskScoring.ts / protocolRiskScoring.ts.
 *
 * ─── THE CORRECTNESS TRAP ────────────────────────────────────────────────────
 *
 * `YieldSnapshot.apy` is NOT a period return. src/agent/snapshotter.ts computes
 * it as cumulative-yield-since-openedAt annualized, so consecutive values are a
 * smoothed running average. Taking stdev() of that column would badly
 * understate volatility and produce a flattering, easily gamed Sharpe.
 *
 * The correct series is portfolio VALUE (`principalAmount + yieldAmount`),
 * bucketed by exact `snapshotAt` so a point is the whole portfolio rather than
 * one position, then differenced into period returns. That is what
 * bucketByInstant + periodReturns below do.
 *
 * ─── THE #225 SEAM ───────────────────────────────────────────────────────────
 *
 * Issue #225 (portfolio analytics: Sharpe/Sortino/volatility) has not landed —
 * there is no analytics service in src/. This module is the ONE definition of
 * risk-adjusted return in the codebase and is the single seam #225 replaces.
 * When it lands, re-point this module at that service; do not add a third
 * definition. See docs/STRATEGY_MARKETPLACE.md.
 *
 * Conventions, all documented in that doc:
 *   - Annualized return uses the same SIMPLE (non-compounding) convention as
 *     snapshotter.calculateApy and goals/service.ts, so marketplace figures
 *     never disagree with the APY shown elsewhere in the product.
 *   - Sharpe uses the SAMPLE standard deviation (n-1), the standard definition.
 *   - The risk-free rate defaults to 0. Stated explicitly beats a hidden
 *     non-zero assumption; it is a parameter so it can be sourced later.
 */

/** A raw snapshot row, already narrowed to the three columns that matter. */
export interface SnapshotRow {
  snapshotAt: Date
  principalAmount: number
  yieldAmount: number
}

/** Whole-portfolio value at one instant. */
export interface PortfolioPoint {
  at: Date
  value: number
}

export interface StrategyMetrics {
  /** Annualized return, in percent. Simple (non-compounding). */
  apy: number
  /** Risk-adjusted return. Null when it cannot be computed — never faked as 0. */
  sharpe: number | null
  /** Number of portfolio points the figures were computed from. */
  sampleCount: number
  /** Whole days of observed history behind the strategy. */
  trackRecordDays: number
  /** True only when the anti-gaming gate below passes. */
  isEligible: boolean
}

export interface StrategyMetricsInput {
  /** The windowed portfolio series (30d or 90d), any order. */
  points: PortfolioPoint[]
  /**
   * Earliest snapshot ever observed for this strategy, which is what
   * `trackRecordDays` measures from. Supplied separately from `points` on
   * purpose: the window governs the RETURN statistics, the track record governs
   * TRUST. Conflating them would make the 30-day window structurally incapable
   * of ever reaching a 30-day track record (its first in-window sample sits
   * ~30 days back, floors to 29, and the leaderboard stays permanently empty).
   * Defaults to the first point when omitted.
   */
  firstObservedAt?: Date | null
  /** Reference "now", injected for deterministic tests. */
  now?: Date
  /**
   * Annual risk-free rate as a decimal (0.04 = 4%). Defaults to
   * DEFAULT_RISK_FREE_RATE; the job sources it from
   * config.strategyMarketplace.riskFreeRate so the baseline is a deploy-time
   * knob rather than a constant buried here.
   */
  riskFreeRate?: number
}

// ── Tunables (mirror docs/STRATEGY_MARKETPLACE.md) ───────────────────────────

/**
 * Minimum observed history before a strategy may appear on the leaderboard.
 * Anti-gaming: a strategy that got lucky for a day must not be able to post a
 * headline APY next to one with real history.
 */
export const MIN_TRACK_RECORD_DAYS = 30

/**
 * Minimum number of portfolio points before volatility (and therefore Sharpe)
 * means anything. Below this the distribution is not characterized, so Sharpe
 * is reported as null and the strategy is ineligible — never scored on thin
 * data, mirroring `insufficientHistory` in riskScoring.ts.
 */
export const MIN_SAMPLES = 14

/** Default annual risk-free rate used for Sharpe. See the header note. */
export const DEFAULT_RISK_FREE_RATE = 0

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_YEAR = 365.25 * MS_PER_DAY

/** Fallback cadence when spacing cannot be inferred: hourly, per snapshotJob. */
const HOURLY_PERIODS_PER_YEAR = MS_PER_YEAR / (60 * 60 * 1000)

/**
 * Floor on the elapsed-years divisor, mirroring snapshotter.calculateYearsActive.
 * Keeps a sub-day series from annualizing into a meaningless number.
 */
const MIN_YEARS = 1 / 365

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

/** Sample standard deviation (n-1) — the standard Sharpe denominator. */
function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance =
    values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Collapse per-position snapshot rows into whole-portfolio points, keyed by the
 * exact snapshot instant. A user with three positions produces three rows per
 * tick; without this the "portfolio" series would be one position's value and
 * the volatility would be wrong. Same aggregation as the valueByInstant pattern
 * in src/jobs/alertRules.ts. Result is sorted ascending by time.
 */
export function bucketByInstant(snaps: SnapshotRow[]): PortfolioPoint[] {
  const valueByInstant = new Map<number, number>()

  for (const s of snaps) {
    const value = s.principalAmount + s.yieldAmount
    if (!Number.isFinite(value)) continue
    const key = s.snapshotAt.getTime()
    valueByInstant.set(key, (valueByInstant.get(key) ?? 0) + value)
  }

  return Array.from(valueByInstant.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([at, value]) => ({ at: new Date(at), value }))
}

/**
 * Difference the value series into simple period returns.
 *
 * An interval whose starting value is <= 0 is SKIPPED rather than yielding
 * Infinity — a portfolio that was empty and then funded is a deposit, not a
 * return, and letting it through would hand the publisher an unbounded Sharpe.
 */
export function periodReturns(points: PortfolioPoint[]): number[] {
  const returns: number[] = []

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value
    const curr = points[i].value
    if (!(prev > 0) || !Number.isFinite(curr)) continue
    const r = (curr - prev) / prev
    if (Number.isFinite(r)) returns.push(r)
  }

  return returns
}

/**
 * Annualized return in percent across the whole series, using the same simple
 * (non-compounding) convention as snapshotter.calculateApy. Returns 0 when the
 * series cannot support a return (fewer than two points, or a non-positive
 * starting value) — 0 is correct here because the caller's eligibility gate,
 * not this number, decides whether the strategy is shown at all.
 */
export function annualizedReturnPercent(points: PortfolioPoint[]): number {
  if (points.length < 2) return 0

  const first = points[0]
  const last = points[points.length - 1]
  if (!(first.value > 0)) return 0

  const totalReturn = (last.value - first.value) / first.value
  const elapsedMs = last.at.getTime() - first.at.getTime()
  if (elapsedMs <= 0) return 0

  const years = Math.max(elapsedMs / MS_PER_YEAR, MIN_YEARS)
  const apy = (totalReturn / years) * 100
  return Number.isFinite(apy) ? apy : 0
}

/**
 * Infer how many return periods a year holds, from the median spacing of the
 * series. Median rather than mean so a single data gap (a restart, a missed
 * job) does not distort the annualization factor.
 */
export function inferPeriodsPerYear(points: PortfolioPoint[]): number {
  if (points.length < 2) return HOURLY_PERIODS_PER_YEAR

  const intervals: number[] = []
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].at.getTime() - points[i - 1].at.getTime()
    if (delta > 0) intervals.push(delta)
  }
  if (intervals.length === 0) return HOURLY_PERIODS_PER_YEAR

  const medianInterval = median(intervals)
  if (!(medianInterval > 0)) return HOURLY_PERIODS_PER_YEAR

  return MS_PER_YEAR / medianInterval
}

/**
 * Annualized Sharpe ratio, or null when it is not computable.
 *
 * Null — never 0, never a sentinel — for: fewer than two returns, and a
 * zero/degenerate standard deviation. A flat series has no risk-adjusted
 * story to tell, and dividing by its zero stdev would produce Infinity, which
 * would sort straight to the top of the leaderboard.
 *
 * @param riskFreeRate Annual rate as a decimal (0.04 = 4%). Defaults to 0.
 */
export function sharpeRatio(
  returns: number[],
  periodsPerYear: number,
  riskFreeRate: number = DEFAULT_RISK_FREE_RATE
): number | null {
  if (returns.length < 2) return null
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) return null

  const sd = sampleStdev(returns)
  if (!Number.isFinite(sd) || sd === 0) return null

  const perPeriodRiskFree = riskFreeRate / periodsPerYear
  const excess = mean(returns) - perPeriodRiskFree
  const sharpe = (excess / sd) * Math.sqrt(periodsPerYear)

  return Number.isFinite(sharpe) ? sharpe : null
}

/**
 * Compute the full metric set + eligibility for one published strategy.
 *
 * Eligibility (the anti-gaming acceptance criterion) is all three of:
 *   trackRecordDays >= MIN_TRACK_RECORD_DAYS
 *   sampleCount     >= MIN_SAMPLES
 *   sharpe          !== null
 *
 * Ineligible strategies are excluded from the leaderboard ENTIRELY by the
 * query layer rather than shown with a low score, so a one-day strategy posting
 * a misleading APY never appears.
 */
export function computeStrategyMetrics(
  input: StrategyMetricsInput
): StrategyMetrics {
  const { points } = input
  const now = input.now ?? new Date()

  const sampleCount = points.length
  const trackRecordStart =
    input.firstObservedAt ?? (points.length > 0 ? points[0].at : null)

  const trackRecordDays = trackRecordStart
    ? Math.max(
        0,
        Math.floor((now.getTime() - trackRecordStart.getTime()) / MS_PER_DAY)
      )
    : 0

  const apy = annualizedReturnPercent(points)

  // Below MIN_SAMPLES we refuse to characterize volatility at all, rather than
  // computing a Sharpe from 3 points and letting the eligibility gate quietly
  // hide how thin it was.
  const sharpe =
    sampleCount >= MIN_SAMPLES
      ? sharpeRatio(
          periodReturns(points),
          inferPeriodsPerYear(points),
          input.riskFreeRate ?? DEFAULT_RISK_FREE_RATE
        )
      : null

  const isEligible =
    trackRecordDays >= MIN_TRACK_RECORD_DAYS &&
    sampleCount >= MIN_SAMPLES &&
    sharpe !== null

  return { apy, sharpe, sampleCount, trackRecordDays, isEligible }
}
