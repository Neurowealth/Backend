/**
 * Agent Types - Core data structures for the autonomous rebalancing system
 */

export interface YieldProtocol {
  name: string;
  apy: number;
  tvl?: number;
  assetSymbol: string;
  lastUpdated: Date;
  isAvailable: boolean;
  errorMessage?: string;
}

export interface ProtocolComparison {
  current: YieldProtocol;
  best: YieldProtocol;
  improvement: number; // percentage points
  shouldRebalance: boolean;
}

export interface RebalanceDetails {
  fromProtocol: string;
  toProtocol: string;
  amount: string;
  estimatedGasfee?: string;
  txHash?: string;
  timestamp: Date;
  improvedBy: number; // percentage points
}

export interface UserBalance {
  userId: string;
  walletAddress: string;
  positionId: string;
  protocolName: string;
  amount: string;
  currentValue: string;
  apy: number;
  snapshotAt: Date;
}

export interface AgentStatus {
  isRunning: boolean;
  lastRebalanceAt?: Date;
  currentProtocol?: string;
  currentApy?: number;
  nextScheduledCheck: Date;
  lastError?: string;
  healthStatus: 'healthy' | 'degraded' | 'error';
}

export interface AgentJobResult {
  jobName: string;
  success: boolean;
  duration: number; // milliseconds
  timestamp: Date;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ProtocolRate {
  protocolName: string;
  assetSymbol: string;
  supplyApy: number;
  borrowApy?: number;
  tvl?: number;
  network: string;
  fetchedAt: Date;
}

export interface RebalanceThresholds {
  minimumImprovement: number; // 0.5% default
  maxGasPercent: number; // 0.1% default
}

export type StrategyName = 'MAX_YIELD' | 'TARGET_ALLOCATION';

export interface StrategyDecision {
  shouldRebalance: boolean;
  targetProtocol: string;
  reasoning: string;
  deviationTrigger?: string;
  details?: Record<string, unknown>;
}

export interface StrategyParams {
  currentProtocol: string;
  totalAmount: string;
  currentApy: number;
  availableProtocols: YieldProtocol[];
  thresholds: RebalanceThresholds;
  userStrategyPreferences: UserStrategyPreferences[];
  /**
   * Optional per-protocol risk scores (0-100, higher = lower risk), keyed by
   * protocol name. Supplied by the caller from ProtocolRiskScore. Only consulted
   * when a strategy is given a riskCeiling; absent scores are treated as
   * ineligible under a ceiling (fail-closed — see StrategyParams.riskCeiling).
   */
  protocolRiskScores?: Record<string, number>;
  /**
   * Optional minimum acceptable risk score. When set, candidate protocols are
   * filtered to those with score >= riskCeiling BEFORE any yield/allocation
   * optimization. Opt-in: when undefined, behavior is byte-for-byte identical to
   * before this parameter existed. A ceiling that excludes every protocol
   * surfaces an explicit "no eligible protocols" decision — it is never silently
   * ignored to keep the agent allocating.
   */
  riskCeiling?: number;
}

export interface RebalanceStrategy {
  readonly name: StrategyName;
  analyze(params: StrategyParams): Promise<StrategyDecision>;
}

export interface UserStrategyPreferences {
  userId: string;
  strategyName?: StrategyName | null;
  targetAllocations?: Record<string, number>;
  riskTolerance?: number;
  /**
   * Optional minimum acceptable protocol risk score (0-100, higher = lower
   * risk). When set, the strategy engine only considers protocols scoring at or
   * above this value. Opt-in and backward compatible: unset means no risk
   * filtering, identical to prior behavior.
   */
  riskCeiling?: number;
}
