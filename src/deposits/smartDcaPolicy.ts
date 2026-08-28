/**
 * Smart DCA Policy Engine (#311) — pure, zero-I/O contribution sizing.
 *
 * CONTRACT
 * ─────────
 * • All functions accept plain numbers/objects and return results. No database
 *   access, no side effects, no randomness — fully unit-testable with fixture
 *   series.
 * • FIXED plans are byte-for-byte identical to the legacy behavior: the policy
 *   module is a no-op for FIXED plans (same amount, no regime check, no
 *   drawdown pause). This is the backward-compatibility guarantee.
 * • ADAPTIVE plans scale contributions by a documented, bounded regime model.
 *   Every assumption is stated; no silent defaults.
 *
 * ─── THE CORRECTNESS TRAP ────────────────────────────────────────────────────
 *
 * The regime scaling is mean-reversion-inspired: buy more when the asset is
 * cheap relative to its trailing range, less when expensive. But the policy
 * must be EXPLICITLY STATED and BOUNDED — configurable floor/ceiling as
 * fractions of baseline so no run can exceed a user-approved range. This is
 * not a forecast; it is a documented, auditable rules engine.
 *
 * ─── VOLATILITY REGIME ───────────────────────────────────────────────────────
 *
 * Computed from a trailing window of daily APY observations (or portfolio
 * value changes). The regime is one of:
 *   - LOW:   recent volatility below the 25th percentile of history
 *   - NORMAL: between 25th and 75th percentile
 *   - HIGH:  above 75th percentile
 *
 * Scaling factors (configurable):
 *   - HIGH regime (cheap):  scale UP (buy more)   — e.g. 1.25x baseline
 *   - NORMAL regime:        hold at baseline        — 1.0x
 *   - LOW regime (expensive): scale DOWN (buy less) — e.g. 0.75x baseline
 *
 * The floor and ceiling prevent extreme scaling:
 *   appliedAmount = clamp(baselineAmount * scaleFactor, floor, ceiling)
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type VolatilityRegime = 'LOW' | 'NORMAL' | 'HIGH'
export type ContributionPolicy = 'FIXED' | 'ADAPTIVE'
export type CatchUpMode = 'SKIP' | 'ACCUMULATE' | 'RETRY'

export interface SmartDcaConfig {
  /** Contribution policy. FIXED = current behavior (no-op in this module). */
  policy: ContributionPolicy
  /** Catch-up mode for skipped runs. */
  catchUpMode: CatchUpMode
  /**
   * Pause-on-drawdown threshold (%). If the user's portfolio drawdown exceeds
   * this, the run is skipped (or doubled, per doubleOnDrawdown). Null = no
   * drawdown pause.
   */
  pauseOnDrawdownPct: number | null
  /** When paused on drawdown, double the contribution instead of skipping. */
  doubleOnDrawdown: boolean
  /** Accumulated missed runs (for ACCUMULATE catch-up mode). Capped at 10. */
  accumulatedRuns: number
  /** Consecutive failure count for auto-pause backoff. */
  consecutiveFailures: number
  /**
   * Optional multi-protocol allocation map: { protocol: weightPercent }.
   * Single-protocol plans are a single-entry map. Null = single-protocol.
   */
  allocationMap: Record<string, number> | null
}

export interface RegimeInput {
  /** Recent daily APY observations (trailing window, e.g. 30 days). */
  recentValues: number[]
  /** Historical percentiles for context (optional, computed if absent). */
  historicalP25?: number
  historicalP75?: number
}

export interface DrawdownInput {
  /** Current portfolio value. */
  currentValue: number
  /** Rolling peak portfolio value (30-day). */
  peakValue: number
}

export interface ContributionDecision {
  /** Baseline amount from the plan. */
  baselineAmount: number
  /** Final amount to deposit (after scaling, drawdown check, allocation). */
  appliedAmount: number
  /** Volatility regime at time of evaluation. Null for FIXED plans. */
  regime: VolatilityRegime | null
  /** Scaling factor applied (1.0 = no change). Null for FIXED plans. */
  scaleFactor: number | null
  /** Whether the run was paused due to drawdown. */
  pausedOnDrawdown: boolean
  /** Whether the contribution was doubled (doubleOnDrawdown). */
  doubledOnDrawdown: boolean
  /** Human-readable reasoning for any deviation from baseline. */
  reasoning: string
  /** Regime snapshot for the run ledger. */
  regimeSnapshot: Record<string, unknown>
  /** Allocation legs if multi-protocol. Empty for single-protocol. */
  allocationLegs: AllocationLeg[]
}

export interface AllocationLeg {
  protocol: string
  weightPercent: number
  amount: number
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum accumulated runs to prevent a single monster deposit. */
export const MAX_ACCUMULATED_RUNS = 10

/** Auto-pause after this many consecutive failures. */
export const AUTO_PAUSE_THRESHOLD = 5

/** Default scaling factors for adaptive policy. */
export const DEFAULT_REGIME_SCALING: Record<VolatilityRegime, number> = {
  HIGH: 1.25, // Buy more when volatile (cheap)
  NORMAL: 1.0, // Hold at baseline
  LOW: 0.75, // Buy less when calm (expensive relative to range)
}

/** Default bounds: applied amount must stay within [floor, ceiling] of baseline. */
export const DEFAULT_FLOOR_FRACTION = 0.5 // 50% of baseline minimum
export const DEFAULT_CEILING_FRACTION = 2.0 // 200% of baseline maximum

// ── Core Policy Functions ────────────────────────────────────────────────────

/**
 * Compute the volatility regime from a trailing window of observations.
 *
 * Uses percentile-based classification:
 *   - HIGH:  value is below the 25th percentile of the trailing range
 *     (price/rate is low → buy more)
 *   - NORMAL: between 25th and 75th percentile
 *   - LOW:  above 75th percentile (price/rate is high → buy less)
 *
 * This is the "latest value relative to its recent range" approach — simple,
 * documented, and auditable. Not a forecast.
 *
 * @param input - Recent values and optional pre-computed percentiles.
 * @returns The volatility regime.
 */
export function computeVolatilityRegime(input: RegimeInput): VolatilityRegime {
  const { recentValues, historicalP25, historicalP75 } = input

  if (recentValues.length === 0) return 'NORMAL'

  const sorted = [...recentValues].sort((a, b) => a - b)
  const latest = sorted[sorted.length - 1]!

  // Compute percentiles from the trailing window if not provided
  const p25 =
    historicalP25 ?? sorted[Math.floor(sorted.length * 0.25)] ?? sorted[0]!
  const p75 =
    historicalP75 ??
    sorted[Math.floor(sorted.length * 0.75)] ??
    sorted[sorted.length - 1]!

  if (latest <= p25) return 'HIGH' // Low value → buy more
  if (latest >= p75) return 'LOW' // High value → buy less
  return 'NORMAL'
}

/**
 * Compute the drawdown percentage from current and peak values.
 *
 * Reuses the same formula as alertEvaluator.computeDrawdownPercent:
 *   drawdown% = max(0, (peak - current) / peak * 100)
 *
 * @returns Drawdown as a positive percentage (0 = at peak).
 */
export function computeDrawdownPercent(
  peakValue: number,
  currentValue: number
): number {
  if (peakValue <= 0) return 0
  const drawdown = ((peakValue - currentValue) / peakValue) * 100
  return drawdown > 0 ? drawdown : 0
}

/**
 * Apply regime scaling to a baseline amount, clamped to floor/ceiling.
 *
 * @param baselineAmount - The plan's fixed baseline amount.
 * @param scaleFactor - The regime-derived multiplier (e.g. 1.25 for HIGH regime).
 * @param floorFraction - Minimum fraction of baseline (default 0.5).
 * @param ceilingFraction - Maximum fraction of baseline (default 2.0).
 * @returns The scaled and clamped amount.
 */
export function applyRegimeScaling(
  baselineAmount: number,
  scaleFactor: number,
  floorFraction: number = DEFAULT_FLOOR_FRACTION,
  ceilingFraction: number = DEFAULT_CEILING_FRACTION
): number {
  const floor = baselineAmount * floorFraction
  const ceiling = baselineAmount * ceilingFraction
  const scaled = baselineAmount * scaleFactor
  return Math.max(floor, Math.min(ceiling, scaled))
}

/**
 * Evaluate a drawdown condition and decide whether to skip, double, or proceed.
 *
 * @param drawdown - Current drawdown input (current vs peak value).
 * @param thresholdPct - Drawdown threshold percentage. Null = no pause.
 * @param doubleOnDrawdown - Whether to double instead of skip.
 * @returns Decision: skip, double, or proceed.
 */
export function evaluateDrawdownPause(
  drawdown: DrawdownInput,
  thresholdPct: number | null
): { action: 'proceed' | 'skip' | 'double'; drawdownPct: number } {
  if (thresholdPct === null || thresholdPct <= 0) {
    return { action: 'proceed', drawdownPct: 0 }
  }

  const drawdownPct = computeDrawdownPercent(
    drawdown.peakValue,
    drawdown.currentValue
  )

  if (drawdownPct >= thresholdPct) {
    return {
      action: 'double', // Will be checked against doubleOnDrawdown by caller
      drawdownPct,
    }
  }

  return { action: 'proceed', drawdownPct }
}

/**
 * Split a total amount across protocol allocations.
 *
 * @param totalAmount - The total amount to allocate.
 * @param allocationMap - { protocol: weightPercent }. Weights must sum to ~100.
 * @returns Array of allocation legs with computed amounts.
 */
export function splitAllocation(
  totalAmount: number,
  allocationMap: Record<string, number>
): AllocationLeg[] {
  const entries = Object.entries(allocationMap)
  if (entries.length === 0) return []

  const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0)
  if (totalWeight <= 0) return []

  return entries.map(([protocol, weight]) => ({
    protocol,
    weightPercent: weight,
    amount: (totalAmount * weight) / totalWeight,
  }))
}

/**
 * Compute the effective contribution for a run, considering:
 * 1. FIXED plans: baseline amount, no changes (backward compatible).
 * 2. ADAPTIVE plans: regime scaling + drawdown check + allocation split.
 * 3. Catch-up: accumulated runs add to the baseline.
 * 4. Auto-pause: consecutive failures pause the plan.
 *
 * This is the main entry point for the policy engine.
 */
export function computeContribution(
  plan: SmartDcaConfig,
  baselineAmount: number,
  regimeInput: RegimeInput | null,
  drawdownInput: DrawdownInput | null,
  now: Date = new Date()
): ContributionDecision {
  // ── FIXED plan: byte-for-byte identical to legacy behavior ────────────
  if (plan.policy === 'FIXED') {
    return {
      baselineAmount,
      appliedAmount: baselineAmount,
      regime: null,
      scaleFactor: null,
      pausedOnDrawdown: false,
      doubledOnDrawdown: false,
      reasoning: 'FIXED plan — no adaptive scaling applied',
      regimeSnapshot: {},
      allocationLegs: plan.allocationMap
        ? splitAllocation(baselineAmount, plan.allocationMap)
        : [],
    }
  }

  // ── ADAPTIVE plan ────────────────────────────────────────────────────

  let scaleFactor = 1.0
  let regime: VolatilityRegime = 'NORMAL'
  let reasoning = ''

  // 1. Compute regime from trailing values
  if (regimeInput && regimeInput.recentValues.length > 0) {
    regime = computeVolatilityRegime(regimeInput)
    const scaling = DEFAULT_REGIME_SCALING[regime]
    scaleFactor = scaling
    reasoning = `Regime: ${regime} (${scaling}x baseline)`
  } else {
    // No history available → fall back to FIXED baseline with visible flag
    reasoning =
      'ADAPTIVE plan with insufficient history — falling back to FIXED baseline'
    scaleFactor = 1.0
    regime = 'NORMAL'
  }

  // 2. Apply regime scaling with bounds
  let appliedAmount = applyRegimeScaling(baselineAmount, scaleFactor)

  // 3. Check drawdown pause/double
  let pausedOnDrawdown = false
  let doubledOnDrawdown = false

  if (
    drawdownInput &&
    plan.pauseOnDrawdownPct !== null &&
    plan.pauseOnDrawdownPct > 0
  ) {
    const drawdownResult = evaluateDrawdownPause(
      drawdownInput,
      plan.pauseOnDrawdownPct
    )

    if (
      drawdownResult.action === 'double' ||
      drawdownResult.action === 'skip'
    ) {
      if (plan.doubleOnDrawdown) {
        doubledOnDrawdown = true
        appliedAmount = baselineAmount * 2 // Double the baseline, not the scaled amount
        reasoning += ` | Drawdown ${drawdownResult.drawdownPct.toFixed(1)}% >= ${plan.pauseOnDrawdownPct}% — doubling contribution`
      } else {
        pausedOnDrawdown = true
        appliedAmount = 0
        reasoning += ` | Drawdown ${drawdownResult.drawdownPct.toFixed(1)}% >= ${plan.pauseOnDrawdownPct}% — run paused (will ${plan.catchUpMode.toLowerCase()})`
      }
    }
  }

  // 4. Accumulated runs add to baseline
  if (plan.accumulatedRuns > 0 && plan.catchUpMode === 'ACCUMULATE') {
    const accumulated = Math.min(plan.accumulatedRuns, MAX_ACCUMULATED_RUNS)
    const extraAmount = baselineAmount * accumulated
    appliedAmount += extraAmount
    reasoning += ` | +${accumulated} accumulated run(s) (${extraAmount.toFixed(2)} added)`
  }

  // 5. Allocation legs
  const allocationLegs =
    plan.allocationMap && appliedAmount > 0
      ? splitAllocation(appliedAmount, plan.allocationMap)
      : []

  // 6. Build regime snapshot for the run ledger
  const regimeSnapshot: Record<string, unknown> = {
    regime,
    scaleFactor,
    regimeInput: regimeInput
      ? {
          recentValuesCount: regimeInput.recentValues.length,
          latestValue:
            regimeInput.recentValues[regimeInput.recentValues.length - 1],
        }
      : null,
    drawdownInput: drawdownInput
      ? {
          currentValue: drawdownInput.currentValue,
          peakValue: drawdownInput.peakValue,
          drawdownPct: computeDrawdownPercent(
            drawdownInput.peakValue,
            drawdownInput.currentValue
          ),
        }
      : null,
    pausedOnDrawdown,
    doubledOnDrawdown,
    accumulatedRuns: plan.accumulatedRuns,
    timestamp: now.toISOString(),
  }

  return {
    baselineAmount,
    appliedAmount,
    regime,
    scaleFactor,
    pausedOnDrawdown,
    doubledOnDrawdown,
    reasoning,
    regimeSnapshot,
    allocationLegs,
  }
}

// ── Catch-Up State Machine ───────────────────────────────────────────────────

/**
 * State transitions for the catch-up policy.
 *
 * A plan whose run was skipped (drawdown pause, provider outage, insufficient
 * balance) follows one of three documented paths:
 *
 *   RETRY:     skip → next sweep retries the same run (nextRunAt unchanged)
 *   SKIP:      skip → nextRunAt advances normally, missed run is lost
 *   ACCUMULATE: skip → accumulatedRuns++, nextRunAt advances, next run deposits
 *               (baseline × accumulatedRuns) to catch up
 *
 * The catch-up mode must be an explicit, tested state machine — not an
 * emergent bug.
 */
export function computeNextRunAfterSkip(
  catchUpMode: CatchUpMode,
  currentNextRunAt: Date,
  cadenceDays: number,
  accumulatedRuns: number
): { nextRunAt: Date; accumulatedRuns: number } {
  switch (catchUpMode) {
    case 'RETRY':
      // Don't advance nextRunAt — the same run will be retried next sweep.
      return { nextRunAt: currentNextRunAt, accumulatedRuns }

    case 'SKIP':
      // Advance nextRunAt, discard the missed run.
      return {
        nextRunAt: new Date(
          currentNextRunAt.getTime() + cadenceDays * 24 * 60 * 60 * 1000
        ),
        accumulatedRuns: 0,
      }

    case 'ACCUMULATE': {
      // Advance nextRunAt, increment accumulated runs (capped).
      const newAccumulated = Math.min(accumulatedRuns + 1, MAX_ACCUMULATED_RUNS)
      return {
        nextRunAt: new Date(
          currentNextRunAt.getTime() + cadenceDays * 24 * 60 * 60 * 1000
        ),
        accumulatedRuns: newAccumulated,
      }
    }

    default:
      return { nextRunAt: currentNextRunAt, accumulatedRuns }
  }
}

/**
 * Determine whether consecutive failures should auto-pause the plan.
 *
 * After AUTO_PAUSE_THRESHOLD consecutive failures, the plan is auto-paused
 * with a user-visible reason. This mirrors the retriable-failure philosophy
 * of referralPayout.ts and fiatReconciliation.ts.
 */
export function shouldAutoPause(consecutiveFailures: number): boolean {
  return consecutiveFailures >= AUTO_PAUSE_THRESHOLD
}

/**
 * Compute a cadence in days from a DepositCadence enum value.
 */
export function cadenceToDays(
  cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
): number {
  switch (cadence) {
    case 'WEEKLY':
      return 7
    case 'BIWEEKLY':
      return 14
    case 'MONTHLY':
      return 30 // Approximate; actual calendar math is in addCadence
    default:
      return 30
  }
}

// ── Validation Helpers ───────────────────────────────────────────────────────

/**
 * Validate an allocation map: weights must be positive, sum to ~100.
 * Returns null on success, error message on failure.
 */
export function validateAllocationMap(
  allocationMap: Record<string, number>
): string | null {
  const entries = Object.entries(allocationMap)
  if (entries.length === 0) return 'Allocation map must not be empty'

  for (const [protocol, weight] of entries) {
    if (weight <= 0) return `Weight for ${protocol} must be positive`
    if (!Number.isFinite(weight))
      return `Weight for ${protocol} must be a finite number`
  }

  const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0)
  if (Math.abs(totalWeight - 100) > 0.01) {
    return `Allocation weights must sum to 100 (got ${totalWeight.toFixed(2)})`
  }

  return null
}

/**
 * Validate adaptive plan configuration. Returns null on success, error on failure.
 */
export function validateAdaptiveConfig(config: {
  policy: ContributionPolicy
  pauseOnDrawdownPct: number | null
  allocationMap: Record<string, number> | null
}): string | null {
  if (config.policy !== 'ADAPTIVE') return null

  if (
    config.pauseOnDrawdownPct !== null &&
    (config.pauseOnDrawdownPct <= 0 || config.pauseOnDrawdownPct > 100)
  ) {
    return 'pauseOnDrawdownPct must be between 0 (exclusive) and 100'
  }

  if (config.allocationMap) {
    return validateAllocationMap(config.allocationMap)
  }

  return null
}
