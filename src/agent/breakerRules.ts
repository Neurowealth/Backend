/**
 * src/agent/breakerRules.ts
 *
 * Pure trip rules for the agent circuit breaker (#345). Each function is
 * deterministic: it takes measured inputs and configuration numbers, never
 * touches the database, the clock, or the environment. The integration layer
 * in the agent loop supplies the measurements; these rules only decide.
 */

export type BreakerTripReason =
  'abnormal_loss' | 'depeg' | 'oscillation' | 'stale_data' | 'manual'

export interface RuleResult {
  tripped: boolean
  rule: BreakerTripReason
  detail: Record<string, unknown>
}

/** A mark-to-market value point for a position or portfolio series. */
export interface ValuePoint {
  at: Date
  value: number
}

interface AbnormalLossInput {
  /** Mark-to-market series, newest-first or oldest-first (sorted internally). */
  series: ValuePoint[]
  lossPct: number
  windowHours: number
  now: Date
}

interface DepegInput {
  /** Current USD price of the stablecoin (1 === $1). null = no feed = fail-safe. */
  price: number | null
  depegBps: number
}

interface OscillationInput {
  /** Rebalance count for the same batchKey within the flip window. */
  flips: number
  maxFlips: number
}

interface StaleDataInput {
  /** Timestamp of the latest successful APY scan. null = never scanned. */
  latestFetchedAt: Date | null
  maxStaleMinutes: number
  maxConsecutiveFailures: number
  consecutiveFailures: number
  now: Date
}

/**
 * Aggregate mark-to-market drawdown rule.
 *
 * Drawdown is measured as (currentValue - peakInWindow) / peakInWindow using
 * the raw point series — the same period-return convention the portfolio-risk
 * analytics stack uses, not a smoothed cumulative column. A short or empty
 * series cannot trip (need at least two points to establish a drawdown).
 *
 * Trips when the window drawdown is worse than `lossPct` (e.g. down >5%).
 */
export function evaluateAbnormalLossRule(input: AbnormalLossInput): RuleResult {
  const { series, lossPct, windowHours, now } = input

  const windowStartMs = now.getTime() - windowHours * 60 * 60 * 1000
  const inWindow = series
    .filter((p) => p.at.getTime() >= windowStartMs)
    .slice()
    .sort((a, b) => a.at.getTime() - b.at.getTime())

  const detail: Record<string, unknown> = { lossPct, windowHours }

  if (inWindow.length < 2) {
    return {
      tripped: false,
      rule: 'abnormal_loss',
      detail: {
        ...detail,
        reason: 'insufficient_history',
        points: inWindow.length,
      },
    }
  }

  const current = inWindow[inWindow.length - 1].value
  let peak = Number.NEGATIVE_INFINITY
  for (const p of inWindow) {
    if (p.value > peak) peak = p.value
  }

  if (peak <= 0 || current <= 0) {
    return {
      tripped: false,
      rule: 'abnormal_loss',
      detail: { ...detail, reason: 'non_positive_peak', peak, current },
    }
  }

  const drawdownPct = ((current - peak) / peak) * 100
  const thresholdPct = -Math.abs(lossPct)
  const tripped = drawdownPct <= thresholdPct

  return {
    tripped,
    rule: 'abnormal_loss',
    detail: {
      ...detail,
      current: round4(current),
      peak: round4(peak),
      drawdownPct: round4(drawdownPct),
      thresholdPct,
    },
  }
}

/**
 * Stablecoin de-peg rule.
 *
 * Trips when the reported USD price deviates more than `depegBps` from $1.
 * A null price (no feed) never trips — the rule fails safe rather than
 * halting rebalancing on missing data; missing *fresh* data is
 * stale_data's job.
 */
export function evaluateDepegRule(input: DepegInput): RuleResult {
  const { price, depegBps } = input

  if (price === null || !Number.isFinite(price) || price <= 0) {
    return {
      tripped: false,
      rule: 'depeg',
      detail: { depegBps, reason: 'no_price_feed' },
    }
  }

  const deviationBps = Math.abs(price - 1) * 10000
  const tripped = deviationBps > depegBps

  return {
    tripped,
    rule: 'depeg',
    detail: {
      depegBps,
      price: round4(price),
      deviationBps: round4(deviationBps),
    },
  }
}

/**
 * Rebalance oscillation rule.
 *
 * Trips when the same batchKey has rebalanced at least `maxFlips` times
 * within the flip window. Detects A→B→A→B fee-burning. Each counted flip
 * individually passed the net-improvement gate, so this is a fee-protection
 * heuristic, not a correctness claim about any single flip.
 */
export function evaluateOscillationRule(input: OscillationInput): RuleResult {
  const { flips, maxFlips } = input
  const tripped = flips >= maxFlips

  return {
    tripped,
    rule: 'oscillation',
    detail: { flips, maxFlips },
  }
}

/**
 * Stale data rule.
 *
 * Trips when the APY table is older than `maxStaleMinutes`, or when scanning
 * has failed at least `maxConsecutiveFailures` times in a row. Never having
 * scanned also trips — trading on a missing APY table is strictly worse than
 * halting. A single failure by itself does not trip (transient blips happen);
 * the consecutive-failure threshold is what makes it a circuit breaker.
 */
export function evaluateStaleDataRule(input: StaleDataInput): RuleResult {
  const {
    latestFetchedAt,
    maxStaleMinutes,
    maxConsecutiveFailures,
    consecutiveFailures,
    now,
  } = input

  const detail: Record<string, unknown> = {
    maxStaleMinutes,
    maxConsecutiveFailures,
  }

  if (consecutiveFailures >= maxConsecutiveFailures) {
    return {
      tripped: true,
      rule: 'stale_data',
      detail: {
        ...detail,
        reason: 'consecutive_scan_failures',
        consecutiveFailures,
      },
    }
  }

  if (latestFetchedAt === null) {
    return {
      tripped: true,
      rule: 'stale_data',
      detail: { ...detail, reason: 'never_scanned' },
    }
  }

  const ageMinutes = (now.getTime() - latestFetchedAt.getTime()) / 60000
  const tripped = ageMinutes > maxStaleMinutes

  return {
    tripped,
    rule: 'stale_data',
    detail: { ...detail, ageMinutes: round4(ageMinutes) },
  }
}

export interface BreakerRuleConfig {
  abnormalLoss: { enabled: boolean; lossPct: number; windowHours: number }
  depeg: { enabled: boolean; depegBps: number }
  oscillation: { enabled: boolean; maxFlips: number }
  staleData: {
    enabled: boolean
    maxStaleMinutes: number
    maxConsecutiveFailures: number
  }
}

export interface BreakerEvalInput {
  /** Optional mark-to-market series for abnormal_loss (skip rule if absent). */
  abnormalLossSeries?: ValuePoint[]
  /** Current stablecoin USD price; null = no feed. */
  depegPrice: number | null
  /** Rebalance count for the batch within the flip window. */
  oscillationFlips: number
  /** Latest successful APY scan time; null = never scanned. */
  latestFetchedAt: Date | null
  /** Consecutive scan failures so far. */
  consecutiveFailures: number
  /** Authoritative evaluation time (the command/fetch time, not Date.now()). */
  now: Date
}

/**
 * Run all enabled rules in evaluation order (abnormal_loss → depeg →
 * oscillation → stale_data) and return the first trip, or a no-trip result.
 * Manual trips are applied through the admin API directly, not here.
 */
export function evaluateBreakerRules(
  config: BreakerRuleConfig,
  input: BreakerEvalInput
): RuleResult {
  const noTrip: RuleResult = {
    tripped: false,
    rule: 'stale_data',
    detail: { reason: 'none' },
  }

  if (config.abnormalLoss.enabled && input.abnormalLossSeries) {
    const r = evaluateAbnormalLossRule({
      series: input.abnormalLossSeries,
      lossPct: config.abnormalLoss.lossPct,
      windowHours: config.abnormalLoss.windowHours,
      now: input.now,
    })
    if (r.tripped) return r
  }

  if (config.depeg.enabled) {
    const r = evaluateDepegRule({
      price: input.depegPrice,
      depegBps: config.depeg.depegBps,
    })
    if (r.tripped) return r
  }

  if (config.oscillation.enabled) {
    const r = evaluateOscillationRule({
      flips: input.oscillationFlips,
      maxFlips: config.oscillation.maxFlips,
    })
    if (r.tripped) return r
  }

  if (config.staleData.enabled) {
    const r = evaluateStaleDataRule({
      latestFetchedAt: input.latestFetchedAt,
      maxStaleMinutes: config.staleData.maxStaleMinutes,
      maxConsecutiveFailures: config.staleData.maxConsecutiveFailures,
      consecutiveFailures: input.consecutiveFailures,
      now: input.now,
    })
    if (r.tripped) return r
  }

  return noTrip
}

/**
 * Validate a breaker config at boot. Throws on impossible values so a
 * misconfigured deployment stops loudly instead of silently guarding nothing.
 */
export function validateBreakerConfig(config: BreakerRuleConfig): void {
  const { abnormalLoss, depeg, oscillation, staleData } = config

  if (abnormalLoss.enabled && abnormalLoss.lossPct <= 0) {
    throw new Error(
      `Invalid BREAKER_LOSS_PCT: ${abnormalLoss.lossPct} (must be > 0)`
    )
  }
  if (abnormalLoss.enabled && abnormalLoss.windowHours <= 0) {
    throw new Error(
      `Invalid BREAKER_LOSS_WINDOW_HOURS: ${abnormalLoss.windowHours} (must be > 0)`
    )
  }
  if (depeg.enabled && depeg.depegBps < 0) {
    throw new Error(
      `Invalid BREAKER_DEPEG_BPS: ${depeg.depegBps} (must be >= 0)`
    )
  }
  if (oscillation.enabled && oscillation.maxFlips < 2) {
    throw new Error(
      `Invalid BREAKER_MAX_FLIPS: ${oscillation.maxFlips} (must be >= 2)`
    )
  }
  if (staleData.enabled && staleData.maxStaleMinutes <= 0) {
    throw new Error(
      `Invalid BREAKER_STALE_MINUTES: ${staleData.maxStaleMinutes} (must be > 0)`
    )
  }
  if (staleData.enabled && staleData.maxConsecutiveFailures < 1) {
    throw new Error(
      `Invalid BREAKER_STALE_CONSECUTIVE_FAILURES: ${staleData.maxConsecutiveFailures} (must be >= 1)`
    )
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
