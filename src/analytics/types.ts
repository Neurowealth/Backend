/**
 * Shared types for the portfolio-optimization engine (#322).
 *
 * ─── UNITS, ONCE, FOR THE WHOLE SUBSYSTEM ────────────────────────────────────
 *
 * Everything in src/analytics/ that is a rate or a weight is a DECIMAL FRACTION:
 *   - expected returns:  0.082  means 8.2% APY
 *   - volatility:        0.014  means 1.4 percentage points of APY volatility
 *   - weights:           0.425  means 42.5% of the portfolio
 *
 * The ONLY place fractions become percentages is `toPercentageAllocations`
 * (optimizer.ts), which emits the 0-100 map that `User.strategyConfig
 * .targetAllocations` and `publishableConfigSchema` speak. Keeping the
 * conversion at exactly one boundary is what makes the "sums to 100 +/- 0.01"
 * invariant assertable in one place.
 *
 * ─── WHAT THE COVARIANCE ACTUALLY MEASURES ───────────────────────────────────
 *
 * ProtocolRate is a YIELD-QUOTE series, not a price series. Sigma here is the
 * covariance of protocols' *quoted annual rates*, so the optimizer minimizes
 * YIELD volatility — how much a protocol's APY swings around. It does NOT model
 * principal loss, depeg, or smart-contract failure. Those live in
 * ProtocolRiskScore, which enters this engine as a universe filter (via
 * applyRiskCeiling) rather than as a term in the objective. This limitation is
 * repeated in the API response and docs/PORTFOLIO_OPTIMIZATION.md rather than
 * left for a user to infer.
 */

/**
 * Per-protocol weight bounds, as decimal fractions. Absent entries default to
 * `[0, 1]`. Keys are protocol names.
 */
export interface AllocationBounds {
  min?: Record<string, number>
  max?: Record<string, number>
}

/**
 * Optional "keep at least this much in the stable group" constraint.
 * `minWeight` is a decimal fraction of the whole portfolio.
 */
export interface StableGroupFloor {
  protocols: string[]
  minWeight: number
}

export interface OptimizerInput {
  /**
   * Protocol names. Need not be sorted — `optimize()` sorts them (and permutes
   * `expectedReturns`/`covariance` to match) so the result never depends on the
   * caller's ordering.
   */
  protocols: string[]
  /** Annualized expected return per protocol, index-aligned with `protocols`. */
  expectedReturns: number[]
  /** Annualized covariance matrix, index-aligned with `protocols`. */
  covariance: number[][]
  /** User's 1-10 risk tolerance. 1 = most risk-averse. */
  riskTolerance: number
  bounds?: AllocationBounds
  stableFloor?: StableGroupFloor
  /** Points on the efficient frontier. Defaults to 12, hard-capped at 25. */
  frontierPoints?: number
  /**
   * Protocol risk scores (0-100, higher = lower risk), used only to REPORT a
   * weighted portfolio risk score. The ceiling itself is applied upstream as a
   * universe filter, so there is one notion of the ceiling, not two.
   */
  riskScores?: Record<string, number>
}

/** One point on the efficient frontier. */
export interface FrontierPoint {
  lambda: number
  /** sqrt(w' Sigma w) — annualized volatility as a decimal fraction. */
  risk: number
  /** mu' w — annualized expected return as a decimal fraction. */
  return: number
  /** Decimal-fraction weights, keyed by protocol name. */
  weights: Record<string, number>
}

/** Why a protocol never made it into the optimizable universe. */
export type ExclusionReason =
  | 'insufficient_history'
  | 'risk_ceiling'
  | 'no_risk_score'
  | 'no_rate_history'
  | 'insufficient_aligned_history'

export interface UniverseExclusion {
  protocol: string
  reason: ExclusionReason
  /** Human-readable detail, e.g. the score that failed the ceiling. */
  detail?: string
}

/**
 * The optimizer's result. A discriminated union on purpose: every failure mode
 * is a named, inspectable state rather than a plausible-looking weight vector
 * that quietly violates a constraint.
 */
export type OptimizationOutcome =
  | {
      status: 'ok'
      /** Decimal-fraction weights, keyed by protocol name. Sums to 1. */
      weights: Record<string, number>
      expectedReturn: number
      expectedVolatility: number
      lambda: number
      frontier: FrontierPoint[]
      iterations: number
      /** Sum of w_i * riskScore_i, when scores were supplied. */
      portfolioRiskScore?: number
    }
  | {
      status: 'infeasible'
      reason: string
      /** Which constraint made the feasible set empty. */
      bindingConstraint: BindingConstraint
    }
  | {
      status: 'insufficient_universe'
      eligibleCount: number
      excluded: UniverseExclusion[]
      /**
       * Set when the universe was emptied by a specific constraint rather than
       * by a plain lack of data — today only `riskCeiling`. Lets the API name
       * the binding constraint for a too-tight ceiling without pretending the
       * outcome was `infeasible` (the feasible SET was never the problem; there
       * were not enough assets to form a portfolio).
       */
      bindingConstraint?: BindingConstraint
    }
  | {
      status: 'non_converged'
      /**
       * The best FEASIBLE iterate found before the budget ran out — every
       * iterate is a projection onto the feasible set, so this always satisfies
       * every constraint. It is simply not proven optimal.
       */
      bestFeasibleWeights: Record<string, number>
      expectedReturn: number
      expectedVolatility: number
      iterations: number
      residual: number
    }

export type BindingConstraint =
  'minWeights' | 'maxWeights' | 'stableFloor' | 'riskCeiling'

// ── Estimation ───────────────────────────────────────────────────────────────

/** One protocol's risk-score row, narrowed to what estimation needs. */
export interface RiskScoreRow {
  protocolName: string
  score: number
  insufficientHistory: boolean
}

export interface EstimationInput {
  /** Raw ProtocolRate observations, any order, possibly gappy. */
  rates: RawRateObservation[]
  riskScores: RiskScoreRow[]
  /** Trailing window in days. Defaults to DEFAULT_LOOKBACK_DAYS. */
  lookbackDays?: number
  /** Minimum protocol risk score to admit, or undefined for no ceiling. */
  riskCeiling?: number
  /** Reference "now", injected for deterministic tests. */
  now?: Date
}

/** A single ProtocolRate row, narrowed to the columns estimation reads. */
export interface RawRateObservation {
  protocolName: string
  assetSymbol: string
  apy: number
  date: Date
}

export interface EstimationResult {
  /** Sorted protocol names, index-aligned with the vectors below. */
  protocols: string[]
  /** Annualized expected return per protocol, as a decimal fraction. */
  expectedReturns: number[]
  /** Annualized covariance of annual rate levels. Symmetric, PSD. */
  covariance: number[][]
  /** Number of days on which EVERY admitted protocol had a value. */
  observationCount: number
  excluded: UniverseExclusion[]
  /** Risk scores for the admitted protocols, for reporting. */
  riskScores: Record<string, number>
  lookbackDays: number
}

// ── Service-level results ────────────────────────────────────────────────────

/** One leg of the backtest comparison. */
export interface BacktestLeg {
  finalValue: number
  realizedApy: number
  maxDrawdownPercent: number
  rebalanceCount: number
  finalProtocol: string
}

/**
 * Suggested-vs-current backtest. `current` is null when the user has no
 * allocation configured — an invented baseline would be worse than none.
 */
export interface BacktestComparison {
  suggested: BacktestLeg
  /** Null when the user has no current allocation to compare against. */
  current: BacktestLeg | null
  startDate: string
  endDate: string
  startingAmount: number
  /**
   * Why this is not a basket simulation. Travels with the data rather than
   * living only in the docs — see computeBacktestComparison in service.ts.
   */
  caveat: string
}

/** What suggestAllocation returns, and what the API serializes. */
export interface AllocationSuggestionResult {
  /** Always true. The response is advice, never an applied change. */
  isSuggestion: true
  disclaimer: string
  userId: string
  /** Set when the suggestion was persisted. */
  id?: string
  inputHash: string
  status: OptimizationOutcome['status']
  /** Percentages summing to 100 +/- 0.01. Empty for a failed outcome. */
  weights: Record<string, number>
  outcome: OptimizationOutcome
  riskTolerance: number
  effectiveRiskCeiling: number | null
  /** Which layer supplied the ceiling, so the API can explain it. */
  ceilingSource: 'goal' | 'follow' | 'own' | 'none'
  currentAllocations: Record<string, number> | null
  excluded: UniverseExclusion[]
  observationCount: number
  lookbackDays: number
  backtest: BacktestComparison | null
  computedAt: string
}
