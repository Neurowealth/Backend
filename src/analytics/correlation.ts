/**
 * Portfolio correlation matrix + diversification score (#348) — pure computation.
 *
 * Same pure-core / DB-glue split as estimation.ts / service.ts: this module does
 * zero I/O and only converts already-aligned observation columns into a Pearson
 * correlation matrix and a single diversification score. src/analytics/
 * correlationService.ts reads the DB and calls in here.
 *
 * ─── ALIGNMENT ──────────────────────────────────────────────────────────────
 *
 * A correlation matrix requires index-aligned observation vectors: entry (i,j)
 * must pair protocol i's value at time t with protocol j's value at the SAME t.
 * We reuse the exact alignment machinery from estimation.ts (aggregateDailyRates
 * → buildDailyRateSeries → keep only days present for EVERY admitted protocol)
 * so a correlation and a covariance NEVER disagree about which days they are
 * looking at. Correlation here is of protocols' quoted ANNUAL RATE LEVELS
 * (ProtocolRate.supplyApy), the same source the optimizer's Sigma comes from —
 * it measures how synchronously two protocols' APYs move, NOT price correlation.
 *
 * ─── UNITS ───────────────────────────────────────────────────────────────────
 *
 * Correlation is dimensionless in [-1, 1]. The diversification score is 0-100.
 */

import { buildDailyRateSeries } from '../agent/backtest'
import { mean, sampleStdev } from '../agent/strategyMetrics'
import { aggregateDailyRates, MIN_ALIGNED_OBSERVATIONS } from './estimation'
import { RawRateObservation, UniverseExclusion } from './types'

const MS_PER_DAY = 24 * 60 * 60 * 1000

function toUtcDay(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY) * MS_PER_DAY
}

/**
 * Pearson correlation matrix for index-aligned columns.
 *
 * Returns null for a pair whose series has zero variance on either side —
 * correlation is undefined there, and 0 would be a lie (it would signal
 * "uncorrelated" when we simply have no information). Null-on-degenerate, never
 * 0. Diagonal is always 1. Symmetric by construction.
 */
export function computeCorrelationMatrix(
  columns: number[][]
): (number | null)[][] {
  const n = columns.length
  const out: (number | null)[][] = Array.from({ length: n }, () =>
    new Array<number | null>(n).fill(null)
  )
  if (n === 0) return out

  const t = columns[0].length
  if (t < 2) return out

  const means = columns.map((c) => mean(c))
  const stdevs = columns.map((c) => sampleStdev(c))

  for (let i = 0; i < n; i++) {
    out[i][i] = 1
    for (let j = i + 1; j < n; j++) {
      if (stdevs[i] === 0 || stdevs[j] === 0) {
        out[i][j] = null
        out[j][i] = null
        continue
      }
      let acc = 0
      for (let k = 0; k < t; k++) {
        acc += (columns[i][k] - means[i]) * (columns[j][k] - means[j])
      }
      const cov = acc / (t - 1)
      const r = cov / (stdevs[i] * stdevs[j])
      const clamped = Math.max(-1, Math.min(1, r))
      out[i][j] = clamped
      out[j][i] = clamped
    }
  }

  return out
}

/**
 * Average pairwise correlation over the matrix (upper triangle, off-diagonal),
 * weighted by portfolio weight when supplied.
 *
 * `weights` is a map of protocol name → decimal-fraction weight. When provided,
 * the correlation of a pair is weighted by the product of the two protocols'
 * weights, so heavily held protocols dominate the score. When absent (or when
 * weights don't sum to ~1), an equal-weight average is used.
 */
export function averagePairwiseCorrelation(
  names: string[],
  correlation: (number | null)[][],
  weights?: Record<string, number>
): number | null {
  const n = names.length
  if (n < 2) return null

  let num = 0
  let den = 0
  const hasWeights = weights && Object.keys(weights).length > 0

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = correlation[i][j]
      if (r === null) continue

      let w = 1
      if (hasWeights) {
        const wi = weights[names[i]] ?? 0
        const wj = weights[names[j]] ?? 0
        if (wi <= 0 || wj <= 0) continue
        w = wi * wj
      }
      num += r * w
      den += w
    }
  }

  if (den <= 0) return null
  return num / den
}

/**
 * Diversification score, 0-100. Higher = more diversified (lower average
 * pairwise correlation).
 *
 * score = clamp((1 − avgCorrelation) × 100, 0, 100). The clamp matters: with a
 * net-negative average correlation the raw expression would exceed 100, which
 * would present "even better than perfectly diversified" — meaningless. Null
 * when fewer than 2 protocols exist or there is no computable average (all pairs
 * degenerate). Null-on-degenerate, never 0.
 */
export function diversificationScore(
  names: string[],
  correlation: (number | null)[][],
  weights?: Record<string, number>
): number | null {
  const avg = averagePairwiseCorrelation(names, correlation, weights)
  if (avg === null) return null
  return Math.max(0, Math.min(100, (1 - avg) * 100))
}

/**
 * The message attached to every correlation response. Correlation here is of
 * quoted APY levels across protocols — it says nothing about principal loss,
 * depeg, or smart-contract failure, and a low-yield correlation is not a plan
 * that all risks are uncorrelated.
 */
export const CORRELATION_CAVEAT =
  "Correlation is computed from historical quoted APY levels, not asset prices. It measures how synchronously protocols' yields have moved and does not model principal loss, depeg, or smart-contract failure."

export interface CorrelationEstimationInput {
  /** Raw ProtocolRate observations, any order, possibly gappy. */
  rates: RawRateObservation[]
  /** Trailing window in days. Defaults to 90. */
  lookbackDays?: number
  /**
   * Portfolio weights (protocol → decimal fraction) used to weight the
   * diversification score. Optional; equal-weight is used when absent.
   */
  weights?: Record<string, number>
  /** Reference "now", injected for deterministic tests. */
  now?: Date
}

export interface CorrelationEstimationResult {
  /** Sorted protocol names. */
  protocols: string[]
  /** Pearson correlation matrix, index-aligned with `protocols`. */
  correlation: (number | null)[][]
  /** Number of days on which EVERY admitted protocol had a value. */
  observationCount: number
  /** Average pairwise correlation (weighted when weights were provided). */
  averageCorrelation: number | null
  /** Diversification score 0-100. */
  diversificationScore: number | null
  excluded: UniverseExclusion[]
  caveat: string
}

/**
 * Estimate the correlation matrix + diversification score from raw rate history.
 *
 * Admission is purely about having rate history in the window (no risk-score /
 * ceiling filtering — unlike estimate() in estimation.ts, correlation asks "how
 * do these yield curves relate", not "is this protocol a good risk"). Protocols
 * with no history are excluded with a machine-readable reason.
 */
export function estimateCorrelation(
  input: CorrelationEstimationInput
): CorrelationEstimationResult {
  const lookbackDays = input.lookbackDays ?? 90
  const now = input.now ?? new Date()
  const excluded: UniverseExclusion[] = []

  const candidates = Array.from(
    new Set(input.rates.map((r) => r.protocolName))
  ).sort()

  const empty = (): CorrelationEstimationResult => ({
    protocols: [],
    correlation: [],
    observationCount: 0,
    averageCorrelation: null,
    diversificationScore: null,
    excluded,
    caveat: CORRELATION_CAVEAT,
  })

  if (candidates.length === 0) return empty()

  const endDay = toUtcDay(now)
  const startDay = endDay - (lookbackDays - 1) * MS_PER_DAY

  const windowed = aggregateDailyRates(
    input.rates.filter(
      (r) => toUtcDay(r.date) >= startDay && toUtcDay(r.date) <= endDay
    )
  )

  const withHistory = new Set(windowed.map((r) => r.protocolName))
  const admitted: string[] = []
  for (const name of candidates) {
    if (withHistory.has(name)) {
      admitted.push(name)
    } else {
      excluded.push({
        protocol: name,
        reason: 'no_rate_history',
        detail: `No rate observations in the trailing ${lookbackDays} days`,
      })
    }
  }

  if (admitted.length < 2) return empty()

  const { series } = buildDailyRateSeries(
    windowed,
    new Date(startDay),
    new Date(endDay)
  )

  const columns: number[][] = admitted.map(() => [])
  let observationCount = 0

  for (const day of series) {
    const byName = new Map(day.protocols.map((p) => [p.name, p.apy]))
    if (admitted.some((name) => !byName.has(name))) continue
    admitted.forEach((name, i) => {
      columns[i].push((byName.get(name) as number) / 100)
    })
    observationCount++
  }

  if (observationCount < MIN_ALIGNED_OBSERVATIONS) {
    for (const name of admitted) {
      excluded.push({
        protocol: name,
        reason: 'insufficient_aligned_history',
        detail: `Only ${observationCount} aligned daily observations; ${MIN_ALIGNED_OBSERVATIONS} required`,
      })
    }
    return empty()
  }

  const correlation = computeCorrelationMatrix(columns)
  const avg = averagePairwiseCorrelation(admitted, correlation, input.weights)

  return {
    protocols: admitted,
    correlation,
    observationCount,
    averageCorrelation: avg,
    diversificationScore:
      avg === null ? null : Math.max(0, Math.min(100, (1 - avg) * 100)),
    excluded,
    caveat: CORRELATION_CAVEAT,
  }
}
