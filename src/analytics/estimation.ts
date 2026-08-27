/**
 * Estimation of optimizer inputs from ProtocolRate history — pure computation (#322).
 *
 * Turns raw, gappy ProtocolRate observations plus ProtocolRiskScore rows into
 * the (universe, mu, Sigma) triple that optimizer.ts consumes. Zero I/O, so the
 * statistics can be unit tested against fixture series; src/analytics/service.ts
 * is the only thing that reads the DB and calls in here. Same pure-core /
 * DB-glue split as riskScoring.ts + jobs/protocolRiskScoring.ts.
 *
 * ─── WHY buildDailyRateSeries AND NOT periodReturns ──────────────────────────
 *
 * A covariance matrix requires INDEX-ALIGNED observation vectors: entry (i,j)
 * must pair protocol i's value at time t with protocol j's value at the SAME t.
 *
 * `periodReturns` (src/agent/strategyMetrics.ts) cannot supply that. It SKIPS
 * any interval whose starting value is non-positive — correct for its own job
 * (a portfolio funded from empty is a deposit, not a return) but fatal here:
 * two protocols skipping different intervals produce vectors of different
 * lengths whose k-th entries are different days. The resulting matrix would look
 * perfectly well-formed and be silently, badly wrong.
 *
 * `buildDailyRateSeries` (src/agent/backtest.ts) already solves exactly this —
 * it forward-fills onto a common daily grid, with a documented gap policy. We
 * take its output and additionally keep only days on which EVERY admitted
 * protocol has a value, which is what makes the vectors genuinely aligned.
 *
 * ─── THE #285 SMOOTHING TRAP ─────────────────────────────────────────────────
 *
 * Inputs derive from ProtocolRate.supplyApy — a per-observation rate QUOTE.
 * They must never derive from YieldSnapshot.apy, which snapshotter.ts computes
 * as cumulative-yield-since-openedAt annualized: consecutive values there are a
 * smoothed running average whose variance badly understates reality. Same trap
 * documented in docs/STRATEGY_MARKETPLACE.md §2.
 *
 * ─── UNITS ───────────────────────────────────────────────────────────────────
 *
 * Sigma is the covariance of ANNUAL RATE LEVELS (apy/100), not of daily returns.
 * See the units note at the top of optimizer.ts for why plan.md's daily-return
 * scaling makes the risk term vanish; ASSUMPTIONS.md records the deviation.
 */

import { buildDailyRateSeries } from '../agent/backtest'
import { mean } from '../agent/strategyMetrics'
import {
  EstimationInput,
  EstimationResult,
  RawRateObservation,
  UniverseExclusion,
} from './types'

// ── Tunables (mirror docs/PORTFOLIO_OPTIMIZATION.md) ─────────────────────────

/** Trailing window the statistics are estimated over. */
export const DEFAULT_LOOKBACK_DAYS = 90

/**
 * Minimum number of days on which every admitted protocol has a value, before
 * a covariance matrix means anything. Mirrors MIN_SAMPLES in strategyMetrics.ts
 * — below this we refuse to characterize the distribution at all rather than
 * optimizing against three points and presenting the answer with equal
 * confidence.
 */
export const MIN_ALIGNED_OBSERVATIONS = 14

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** UTC midnight for a timestamp, so day bucketing is timezone-independent. */
function toUtcDay(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY) * MS_PER_DAY
}

/**
 * Collapse observations to ONE value per (protocol, UTC day) by averaging.
 *
 * ProtocolRate is keyed by (protocolName, assetSymbol, network, fetchedAt), so a
 * protocol routinely has several rows for one day — multiple assets, and several
 * scans per day. buildDailyRateSeries groups by protocolName alone and keeps
 * whichever row it visits last, which would make the series depend on scan
 * ordering. Averaging first makes the daily value a well-defined, deterministic
 * property of the day rather than an artifact of collection order.
 */
export function aggregateDailyRates(
  rates: RawRateObservation[]
): RawRateObservation[] {
  // The name is carried in the VALUE rather than parsed back out of the key:
  // protocol names contain spaces ("Stellar DEX"), so splitting the key on one
  // would silently truncate them into a different protocol.
  const byKey = new Map<
    string,
    { sum: number; count: number; day: number; protocolName: string }
  >()

  for (const r of rates) {
    if (!Number.isFinite(r.apy)) continue
    const day = toUtcDay(r.date)
    const key = `${r.protocolName} ${day}`
    const entry = byKey.get(key)
    if (entry) {
      entry.sum += r.apy
      entry.count++
    } else {
      byKey.set(key, {
        sum: r.apy,
        count: 1,
        day,
        protocolName: r.protocolName,
      })
    }
  }

  return Array.from(byKey.values())
    .map((v) => ({
      protocolName: v.protocolName,
      assetSymbol: 'AGGREGATE',
      apy: v.sum / v.count,
      date: new Date(v.day),
    }))
    .sort((a, b) =>
      a.date.getTime() !== b.date.getTime()
        ? a.date.getTime() - b.date.getTime()
        : a.protocolName < b.protocolName
          ? -1
          : 1
    )
}

/**
 * Sample covariance matrix (n-1 convention, matching sampleStdev in
 * strategyMetrics.ts). `columns[i]` is protocol i's observation vector; all
 * vectors must be the same length and index-aligned.
 *
 * Built symmetric BY CONSTRUCTION — the (j,i) entry is assigned from the (i,j)
 * computation rather than recomputed — so floating-point associativity can never
 * produce a matrix that is asymmetric at the 1e-18 level and quietly fails a PSD
 * assertion downstream.
 */
export function sampleCovariance(columns: number[][]): number[][] {
  const n = columns.length
  const out: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0)
  )
  if (n === 0) return out

  const t = columns[0].length
  if (t < 2) return out

  const means = columns.map((c) => mean(c))

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let acc = 0
      for (let k = 0; k < t; k++) {
        acc += (columns[i][k] - means[i]) * (columns[j][k] - means[j])
      }
      const cov = acc / (t - 1)
      out[i][j] = cov
      out[j][i] = cov
    }
  }

  return out
}

/**
 * Build the optimizable universe and its statistics.
 *
 * Universe eligibility is FAIL-CLOSED at every step, matching applyRiskCeiling
 * (src/agent/strategies.ts): a protocol is admitted only when it has a risk-score
 * row, that row is not flagged insufficientHistory, it clears any configured
 * ceiling, and it actually has rate history in the window. Anything else is
 * excluded WITH A MACHINE-READABLE REASON — never silently dropped, so the API
 * can always explain why a protocol the user expected to see is missing.
 */
export function estimate(input: EstimationInput): EstimationResult {
  const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const now = input.now ?? new Date()
  const excluded: UniverseExclusion[] = []

  // ── 1. Risk-score eligibility ──────────────────────────────────────────────

  const scoreByProtocol = new Map(
    input.riskScores.map((r) => [r.protocolName, r])
  )

  // Every protocol that appears in either source is a candidate, so a protocol
  // with rate history but no score row is reported as excluded rather than
  // never mentioned.
  const candidates = new Set<string>()
  for (const r of input.rates) candidates.add(r.protocolName)
  for (const s of input.riskScores) candidates.add(s.protocolName)

  const admitted: string[] = []
  const riskScores: Record<string, number> = {}

  for (const name of Array.from(candidates).sort()) {
    const score = scoreByProtocol.get(name)

    if (!score) {
      excluded.push({
        protocol: name,
        reason: 'no_risk_score',
        detail: 'No ProtocolRiskScore row — excluded fail-closed',
      })
      continue
    }
    if (score.insufficientHistory) {
      excluded.push({
        protocol: name,
        reason: 'insufficient_history',
        detail: 'Risk score flagged insufficientHistory',
      })
      continue
    }
    if (input.riskCeiling !== undefined && score.score < input.riskCeiling) {
      excluded.push({
        protocol: name,
        reason: 'risk_ceiling',
        detail: `Risk score ${score.score} is below the ${input.riskCeiling} ceiling`,
      })
      continue
    }

    admitted.push(name)
    riskScores[name] = score.score
  }

  const empty = (): EstimationResult => ({
    protocols: [],
    expectedReturns: [],
    covariance: [],
    observationCount: 0,
    excluded,
    riskScores: {},
    lookbackDays,
  })

  if (admitted.length === 0) return empty()

  // ── 2. Rate history on a common daily grid ─────────────────────────────────

  const admittedSet = new Set(admitted)
  const endDay = toUtcDay(now)
  const startDay = endDay - (lookbackDays - 1) * MS_PER_DAY

  const windowed = aggregateDailyRates(
    input.rates.filter(
      (r) =>
        admittedSet.has(r.protocolName) &&
        toUtcDay(r.date) >= startDay &&
        toUtcDay(r.date) <= endDay
    )
  )

  const withHistory = new Set(windowed.map((r) => r.protocolName))
  const surviving: string[] = []
  for (const name of admitted) {
    if (withHistory.has(name)) {
      surviving.push(name)
    } else {
      excluded.push({
        protocol: name,
        reason: 'no_rate_history',
        detail: `No rate observations in the trailing ${lookbackDays} days`,
      })
      delete riskScores[name]
    }
  }

  if (surviving.length === 0) return empty()

  const { series } = buildDailyRateSeries(
    windowed,
    new Date(startDay),
    new Date(endDay)
  )

  // Keep only days where EVERY surviving protocol has a value. This is the step
  // that makes the observation vectors index-aligned; see the header.
  const columns: number[][] = surviving.map(() => [])
  let observationCount = 0

  for (const day of series) {
    const byName = new Map(day.protocols.map((p) => [p.name, p.apy]))
    if (surviving.some((name) => !byName.has(name))) continue

    surviving.forEach((name, i) => {
      // Annual RATE LEVEL as a decimal fraction: 8.4% APY -> 0.084.
      columns[i].push((byName.get(name) as number) / 100)
    })
    observationCount++
  }

  if (observationCount < MIN_ALIGNED_OBSERVATIONS) {
    // The universe as a whole is too thin. Every surviving protocol is reported
    // with the same reason so the caller can say precisely what was missing,
    // and the empty universe surfaces as `insufficient_universe` upstream.
    for (const name of surviving) {
      excluded.push({
        protocol: name,
        reason: 'insufficient_aligned_history',
        detail: `Only ${observationCount} aligned daily observations; ${MIN_ALIGNED_OBSERVATIONS} required`,
      })
    }
    return empty()
  }

  return {
    protocols: surviving,
    expectedReturns: columns.map((c) => mean(c)),
    covariance: sampleCovariance(columns),
    observationCount,
    excluded,
    riskScores,
    lookbackDays,
  }
}
