/**
 * Agent Types - Core data structures for the autonomous rebalancing system
 */

export interface YieldProtocol {
  name: string
  apy: number
  tvl?: number
  assetSymbol: string
  lastUpdated: Date
  isAvailable: boolean
  errorMessage?: string
  /** #349: base (market) rate, optional split of `apy`. */
  baseApy?: number
  /** #349: incentive (token-reward) rate, optional split of `apy`. */
  incentiveApy?: number
  /** #349: reward-token metadata (symbol, address, apy). */
  rewardTokens?: Array<{
    symbol: string
    address?: string
    apy?: number
  }>
}

export interface ProtocolComparison {
  current: YieldProtocol
  best: YieldProtocol
  improvement: number // percentage points
  shouldRebalance: boolean
}

export interface RebalanceDetails {
  fromProtocol: string
  toProtocol: string
  amount: string
  estimatedGasfee?: string
  txHash?: string
  timestamp: Date
  improvedBy: number // percentage points
}

export interface UserBalance {
  userId: string
  walletAddress: string
  positionId: string
  protocolName: string
  amount: string
  currentValue: string
  apy: number
  snapshotAt: Date
}

export interface AgentStatus {
  isRunning: boolean
  lastRebalanceAt?: Date
  currentProtocol?: string
  currentApy?: number
  nextScheduledCheck: Date
  lastError?: string
  healthStatus: 'healthy' | 'degraded' | 'error'
}

export interface AgentJobResult {
  jobName: string
  success: boolean
  duration: number // milliseconds
  timestamp: Date
  details?: Record<string, unknown>
  error?: string
}

export interface ProtocolRate {
  protocolName: string
  assetSymbol: string
  supplyApy: number
  borrowApy?: number
  tvl?: number
  network: string
  fetchedAt: Date
}

export interface RebalanceThresholds {
  minimumImprovement: number // 0.5% default
  maxGasPercent: number // 0.1% default
}

export type StrategyName = 'MAX_YIELD' | 'TARGET_ALLOCATION' | 'GOAL_TRACKING'

export interface StrategyDecision {
  shouldRebalance: boolean
  targetProtocol: string
  reasoning: string
  deviationTrigger?: string
  details?: Record<string, unknown>
}

export interface StrategyParams {
  currentProtocol: string
  totalAmount: string
  currentApy: number
  availableProtocols: YieldProtocol[]
  thresholds: RebalanceThresholds
  userStrategyPreferences: UserStrategyPreferences[]
  /**
   * Optional per-protocol risk scores (0-100, higher = lower risk), keyed by
   * protocol name. Supplied by the caller from ProtocolRiskScore. Only consulted
   * when a strategy is given a riskCeiling; absent scores are treated as
   * ineligible under a ceiling (fail-closed — see StrategyParams.riskCeiling).
   */
  protocolRiskScores?: Record<string, number>
  /**
   * Optional minimum acceptable risk score. When set, candidate protocols are
   * filtered to those with score >= riskCeiling BEFORE any yield/allocation
   * optimization. Opt-in: when undefined, behavior is byte-for-byte identical to
   * before this parameter existed. A ceiling that excludes every protocol
   * surfaces an explicit "no eligible protocols" decision — it is never silently
   * ignored to keep the agent allocating.
   */
  riskCeiling?: number
  /**
   * Optional active SavingsGoal (#281) driving GoalTrackingStrategy. Only
   * consulted by that strategy — absent for MaxYieldStrategy/TargetAllocationStrategy
   * callers, which are unaffected by this field's presence.
   */
  goal?: {
    targetAmount: number
    startingAmount: number
    targetDate: Date
  }
  /**
   * Exposure context (#346): the user's whole-portfolio per-protocol split and
   * the caps in effect. Optional for backward compatibility — strategies with no
   * exposure awareness see nothing and behave as before.
   */
  exposure?: ExposureContext
  /**
   * Live network fee-oracle snapshot (#347). Null/absent means the cost model
   * falls back to conservative constants and lowers its confidence. Mirrors the
   * rebalanceCost.FeeSnapshot shape without importing it (avoids a type cycle).
   */
  feeSnapshot?: {
    recommendedBaseFee: number
    congestionLevel?: 'low' | 'medium' | 'high'
    fetchedAt?: Date | null
  } | null
  /**
   * Per-protocol entry+exit cost in bps (#347), used by the cost model.
   */
  protocolEntryExitBps?: Record<string, number>
}

export interface RebalanceStrategy {
  readonly name: StrategyName
  analyze(params: StrategyParams): Promise<StrategyDecision>
}

export interface UserStrategyPreferences {
  userId: string
  strategyName?: StrategyName | null
  targetAllocations?: Record<string, number>
  riskTolerance?: number
  /**
   * Optional minimum acceptable protocol risk score (0-100, higher = lower
   * risk). When set, the strategy engine only considers protocols scoring at or
   * above this value. Opt-in and backward compatible: unset means no risk
   * filtering, identical to prior behavior.
   */
  riskCeiling?: number
  /**
   * Id of the PublishedStrategy this user's config was copied from (#285), when
   * they follow one. Carried for AgentLog attribution only — it is never used to
   * make a decision and never reaches another user's response. Absent for the
   * overwhelming majority of users, who follow nothing.
   */
  followedStrategyId?: string | null
  /**
   * Per-protocol exposure cap overrides (#346), from strategyConfig.exposureCaps.
   * Each value is { maxFraction?, maxAbsolute? }. Absent for users who never
   * configured caps.
   */
  exposureCaps?: Record<string, { maxFraction?: number; maxAbsolute?: string }>
  /**
   * Per-user default max single-protocol fraction (#346), from
   * strategyConfig.defaultMaxFraction. Takes precedence over the risk-tolerance
   * table but yields to a per-protocol override.
   */
  defaultMaxFraction?: number
}

/**
 * Per-protocol exposure context handed to a strategy (#346). Describes how the
 * user's whole ACTIVE portfolio is currently split and the caps in effect, so a
 * strategy can (a) prefer targets with headroom under cap and (b) surface
 * capConstraints in its decision. Pure data produced by the rebalancer from the
 * caller's own positions.
 */
export interface ExposureContext {
  /** Current fraction of the portfolio in each protocol. */
  fractions: Record<string, number>
  /**
   * Effective cap per protocol: { maxFraction, maxAbsolute?, source }.
   * Only present for protocols that have a cap supplied by the caller.
   */
  caps: Record<
    string,
    { maxFraction: number; maxAbsolute?: string; source: string }
  >
  /** Protocol names with a current fraction above their effective cap. */
  overCap: string[]
  /** True when the sum of caps over the eligible set < 1 (unplaceable). */
  unplaceable: boolean
}
