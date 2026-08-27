/**
 * Protocol risk scoring — pure computation.
 *
 * Turns a protocol's ProtocolRate history plus curated audit/age metadata into a
 * normalized 0-100 risk score (higher = lower risk) and the contributing
 * factors behind it. This module is deliberately free of I/O so it can be unit
 * tested against fixture rate histories; the scheduled job in
 * src/jobs/protocolRiskScoring.ts is the only thing that reads the DB and calls
 * into here.
 *
 * The full methodology (weights, thresholds, gap/new-protocol policy, what
 * "third-party audited" means) is documented in docs/PROTOCOL_RISK_SCORING.md.
 * Keep that doc and this file in sync — the transparency endpoint exposes these
 * factors precisely so a user can reconcile them against the docs.
 */

import {
  AuditStatusValue,
  computeProtocolAgeDays,
  getProtocolMetadata,
} from '../config/protocolRiskMetadata'

/** A single historical rate sample for one protocol (asset-agnostic here). */
export interface RateSample {
  supplyApy: number
  tvl: number | null
  fetchedAt: Date
}

export interface RiskScoreFactors {
  /**
   * Rolling TVL growth/decline signal in [0,1]. 1 = strongly growing (lower
   * risk), 0.5 = flat/unknown, 0 = strongly declining (higher risk).
   */
  tvlTrendFactor: number
  /**
   * APY stability signal in [0,1]. 1 = very stable APY (lower risk), 0 = highly
   * volatile APY (higher risk). Derived from the standard deviation of APY over
   * the trailing window.
   */
  apyVolatilityFactor: number
  auditStatus: AuditStatusValue
  protocolAgeDays: number
  /** Number of samples the factors were computed from. */
  sampleCount: number
  /** True when history is too sparse to compute volatility/trend meaningfully. */
  insufficientHistory: boolean
}

export interface RiskScoreResult extends RiskScoreFactors {
  protocolName: string
  /** Normalized 0-100, higher = lower risk. */
  score: number
}

// ── Tunables (mirror docs/PROTOCOL_RISK_SCORING.md) ──────────────────────────

/**
 * Minimum number of samples required to compute volatility/trend. Below this we
 * cannot meaningfully characterize the distribution, so the protocol is flagged
 * `insufficientHistory` and scored conservatively low rather than neutral.
 */
export const MIN_SAMPLES_FOR_HISTORY = 3

/** Trailing window over which volatility/trend are measured. */
export const TRAILING_WINDOW_DAYS = 30

/**
 * APY standard deviation (in percentage points) mapped to the volatility floor.
 * At/above this stdev the apyVolatilityFactor is 0; at 0 stdev it is 1.
 */
export const APY_STDEV_FLOOR = 5

/** Protocol age (days) at which the age contribution saturates to full credit. */
export const AGE_SATURATION_DAYS = 730 // ~2 years

/** Score (0-100) assigned to protocols flagged insufficientHistory. */
export const INSUFFICIENT_HISTORY_SCORE = 20

/** Component weights. Must sum to 1. */
export const WEIGHTS = {
  audit: 0.35,
  volatility: 0.25,
  tvlTrend: 0.2,
  age: 0.2,
} as const

const AUDIT_FACTOR: Record<AuditStatusValue, number> = {
  THIRD_PARTY_AUDITED: 1,
  SELF_REPORTED: 0.5,
  UNAUDITED: 0,
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = mean(values.map((v) => (v - m) ** 2))
  return Math.sqrt(variance)
}

/**
 * Gap-handling policy (documented in docs/PROTOCOL_RISK_SCORING.md):
 *
 * We do NOT fabricate values for missing sample intervals. Volatility and trend
 * are computed only from samples that actually exist in the trailing window —
 * missing data is treated as absence, never as zero and never as a favorable
 * (stable/growing) signal. The practical effect is that a data gap reduces the
 * effective sampleCount; if that drops the count below MIN_SAMPLES_FOR_HISTORY
 * the protocol is flagged `insufficientHistory` rather than scored on thin data.
 */
export function filterToWindow(
  samples: RateSample[],
  now: Date,
  windowDays = TRAILING_WINDOW_DAYS
): RateSample[] {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000
  return samples
    .filter((s) => s.fetchedAt.getTime() >= cutoff)
    .sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())
}

/**
 * APY stability in [0,1] from the standard deviation of APY across the window.
 * Higher stdev → lower factor. Linear falloff to 0 at APY_STDEV_FLOOR.
 */
export function computeApyVolatilityFactor(samples: RateSample[]): number {
  const apys = samples.map((s) => s.supplyApy).filter((v) => Number.isFinite(v))
  if (apys.length < 2) return 0
  const sd = stdev(apys)
  return clamp01(1 - sd / APY_STDEV_FLOOR)
}

/**
 * TVL trend in [0,1] from the relative change between the first and last TVL
 * observation in the window. Growth → toward 1, decline → toward 0, flat → 0.5.
 * Samples with null TVL are ignored. Unknown (no usable TVL data) → 0.5 neutral,
 * since absence of TVL data is not itself a risk signal about direction.
 */
export function computeTvlTrendFactor(samples: RateSample[]): number {
  const tvls = samples
    .map((s) => s.tvl)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0)
  if (tvls.length < 2) return 0.5
  const first = tvls[0]
  const last = tvls[tvls.length - 1]
  const relChange = (last - first) / first // e.g. +0.2 = +20% growth
  // Map [-0.5, +0.5] relative change onto [0,1], centered at 0.5 (flat).
  return clamp01(0.5 + relChange)
}

/** Age credit in [0,1], linear from 0 days to AGE_SATURATION_DAYS. */
export function computeAgeFactor(protocolAgeDays: number): number {
  return clamp01(protocolAgeDays / AGE_SATURATION_DAYS)
}

/**
 * Compute a full risk score + factor breakdown for one protocol.
 *
 * @param protocolName  Must match the curated metadata / scanner protocol name.
 * @param samples       All available rate history for the protocol (any age).
 * @param now           The reference "now" (injected for deterministic tests).
 */
export function computeRiskScore(
  protocolName: string,
  samples: RateSample[],
  now: Date
): RiskScoreResult {
  const meta = getProtocolMetadata(protocolName)
  const protocolAgeDays = computeProtocolAgeDays(meta.inceptionDate, now)

  const windowed = filterToWindow(samples, now)
  const sampleCount = windowed.length
  const insufficientHistory = sampleCount < MIN_SAMPLES_FOR_HISTORY

  const apyVolatilityFactor = computeApyVolatilityFactor(windowed)
  const tvlTrendFactor = computeTvlTrendFactor(windowed)

  const factors: RiskScoreFactors = {
    tvlTrendFactor,
    apyVolatilityFactor,
    auditStatus: meta.auditStatus,
    protocolAgeDays,
    sampleCount,
    insufficientHistory,
  }

  // A protocol without enough history cannot be characterized on
  // volatility/trend. Rather than let audit + age alone produce a
  // misleadingly high score, cap it at a conservative floor.
  if (insufficientHistory) {
    return { protocolName, score: INSUFFICIENT_HISTORY_SCORE, ...factors }
  }

  const auditFactor = AUDIT_FACTOR[meta.auditStatus]
  const ageFactor = computeAgeFactor(protocolAgeDays)

  const weighted =
    WEIGHTS.audit * auditFactor +
    WEIGHTS.volatility * apyVolatilityFactor +
    WEIGHTS.tvlTrend * tvlTrendFactor +
    WEIGHTS.age * ageFactor

  const score = Math.round(clamp01(weighted) * 100)

  return { protocolName, score, ...factors }
}
