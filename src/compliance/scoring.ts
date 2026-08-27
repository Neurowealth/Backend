/**
 * Transaction risk-scoring engine (#321).
 *
 * Pure, side-effect-free, deterministic feature extraction + scoring so the
 * suspicion model can be unit-tested in isolation from the database and the
 * on-chain listener — same rationale as src/services/alertEvaluator.ts. Every
 * caller (transaction persistence, the batch monitoring job, a future admin
 * "re-score" tool) hands in a snapshot of what's already known about the
 * account; nothing in here reads the clock or does I/O. Time-window features
 * anchor on `transaction.createdAt`, not `Date.now()`, so the same inputs
 * always produce the same output.
 *
 * Model summary (v1, rules-based — see MODEL_VERSION):
 *   AMOUNT_ANOMALY (0.25)     — MAD-based modified z-score vs. the account's
 *                                own historical amounts for this transaction
 *                                type/asset. Robust to outliers; unlike a
 *                                mean/stddev z-score, a handful of large past
 *                                transactions can't numb the model to a new
 *                                one that's equally large.
 *   VELOCITY (0.20)           — count/volume of deposits+withdrawals in a
 *                                window, plus round-trip detection (an
 *                                opposite-direction transaction of a similar
 *                                amount shortly before/after).
 *   STRUCTURING (0.20)        — repeated deposits/withdrawals just under a
 *                                configured reporting-style threshold.
 *   NEW_DESTINATION (0.15)    — transfer to a Stellar address with no prior
 *                                history on this account.
 *   ACCOUNT_AGE (0.05)        — how new the account is at transaction time.
 *   SUB_ACCOUNT_FANOUT (0.10) — a parent account whose children are
 *                                concentrating deposit activity (mule
 *                                pattern).
 *   REFERRAL_GRAPH (0.05)     — a referred user's first-ever action being a
 *                                large withdrawal.
 *
 * Weights sum to 1.0 (see DEFAULT_SCORING_CONFIG.weights); each feature's own
 * score is bounded to [0, 100], so the weighted sum is always a valid 0-100
 * suspicion score. MODEL_VERSION is carried on every result so a future
 * recalibration (different weights/thresholds) never rewrites the meaning of
 * a score already persisted against an old version.
 *
 * Agent-driven exemption: VELOCITY and STRUCTURING both look for rapid,
 * repeated deposit/withdraw-like patterns — exactly what the agent's own
 * rebalances legitimately produce (src/agent/). A transaction linked to an
 * AgentLog entry (`isAgentDriven: true`) skips both features entirely
 * (reason code AGENT_DRIVEN_EXEMPT), and agent-driven rows are excluded from
 * every other feature's historical baseline so they can't inflate a user's
 * own velocity/structuring/amount profile either. See
 * scoreTransaction.agentRebalance tests for the false-positive guard this
 * exists to satisfy.
 */

// ── Public types ──────────────────────────────────────────────────────────

export type TransactionTypeLike =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'YIELD_CLAIM'
  | 'REBALANCE'
  | 'SWAP'
  | 'REFERRAL_REWARD'

/** A prior transaction on the account, used as scoring context. */
export interface HistoricalTransaction {
  type: TransactionTypeLike
  amount: number
  assetSymbol: string
  createdAt: Date
  destinationAddress?: string | null
  /** True when linked to an AgentLog entry (agent-initiated, not user-initiated). */
  isAgentDriven: boolean
}

/** The transaction being scored right now. */
export interface ScoredTransaction {
  id: string
  userId: string
  type: TransactionTypeLike
  amount: number
  assetSymbol: string
  createdAt: Date
  destinationAddress?: string | null
  isAgentDriven: boolean
}

export interface SubAccountContext {
  /** Number of child sub-accounts this user is the parent of. */
  childCount: number
  /** Distinct children who made a deposit within the fan-out detection window. */
  recentChildDepositCount: number
}

export interface ReferralContext {
  isReferred: boolean
  /** True when the transaction being scored is this user's first-ever transaction. */
  isFirstAction: boolean
}

export interface AccountContext {
  userId: string
  accountCreatedAt: Date
  /** Prior transactions on this account, in any order, EXCLUDING the one being scored. */
  transactionHistory: HistoricalTransaction[]
  /** Every destination address this account has transacted with before. */
  knownDestinationAddresses: string[]
  /**
   * Age (ms) of the destination's own platform account at transaction time,
   * when the destination is a known platform user. null/undefined when the
   * destination is external or unknown — treated as "can't assess," not "old."
   */
  destinationAccountAgeMs?: number | null
  subAccount?: SubAccountContext
  referral?: ReferralContext
}

export interface TransactionContext {
  transaction: ScoredTransaction
  account: AccountContext
}

export type FeatureCode =
  | 'AMOUNT_ANOMALY'
  | 'VELOCITY'
  | 'STRUCTURING'
  | 'NEW_DESTINATION'
  | 'ACCOUNT_AGE'
  | 'SUB_ACCOUNT_FANOUT'
  | 'REFERRAL_GRAPH'

export interface FeatureScore {
  feature: FeatureCode
  /** This feature's own bounded sub-score, independent of its weight. */
  score: number
  /** Configured weight for this feature (sums to 1.0 across all features). */
  weight: number
  /** score * weight — this feature's share of the total. */
  contribution: number
  triggered: boolean
  reasonCodes: string[]
  detail: string
}

export interface ScoringResult {
  modelVersion: string
  transactionId: string
  userId: string
  /** 0-100 total suspicion score, rounded. */
  totalScore: number
  features: FeatureScore[]
  /** Flattened reason codes of every triggered feature, for quick display. */
  reasonCodes: string[]
}

export interface ScoringConfig {
  weights: Record<FeatureCode, number>
  amount: {
    /** Below this many historical samples, the feature is skipped (not enough data for a norm). */
    minHistorySamples: number
    /** |z| at/below which the amount is unremarkable (score 0). */
    lowZ: number
    /** |z| at/above which the score saturates at 100. */
    highZ: number
  }
  velocity: {
    windowMs: number
    /** Count (including the current transaction) at/below which score is 0. */
    lowCountThreshold: number
    /** Count at/above which the frequency score saturates at 100. */
    highCountThreshold: number
    /** Volume as a multiple of the account's historical median at which the volume score saturates. */
    highVolumeMultiple: number
    roundTrip: {
      /** How soon before/after an opposite-direction transaction still counts as a round-trip. */
      windowMs: number
      /** Fraction (e.g. 0.05 = 5%) two amounts must be within to count as "the same amount." */
      amountTolerancePct: number
    }
  }
  structuring: {
    /** The reporting-style amount being structured under (e.g. a CTR-style threshold). */
    threshold: number
    /** Fraction below `threshold` considered "just under" it (e.g. 0.10 = 90%-100% of threshold). */
    bandPct: number
    windowMs: number
    /** Occurrences (including the current transaction) at/above which score saturates at 100. */
    minOccurrences: number
  }
  newDestination: {
    /** Amount at/above which a first-time destination scores at its maximum. */
    largeAmountThreshold: number
    /** Destination account age below which it's treated as elevated risk. */
    youngAccountMs: number
  }
  accountAge: {
    /** Below this age, score ramps from 100 (brand new) down to 0 (at the window edge). */
    newAccountWindowMs: number
  }
  subAccountFanOut: {
    /** Child count at/above which fan-out scoring engages at all. */
    childCountThreshold: number
    /** Recent child deposit count at/above which score saturates at 100. */
    childDepositConcentrationThreshold: number
  }
  referralGraph: {
    /** Amount at/above which a referred user's first-action withdrawal saturates at 100. */
    firstActionLargeWithdrawalThreshold: number
  }
}

// ── Default configuration ────────────────────────────────────────────────

export const MODEL_VERSION = 'v1'

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: {
    AMOUNT_ANOMALY: 0.25,
    VELOCITY: 0.2,
    STRUCTURING: 0.2,
    NEW_DESTINATION: 0.15,
    ACCOUNT_AGE: 0.05,
    SUB_ACCOUNT_FANOUT: 0.1,
    REFERRAL_GRAPH: 0.05,
  },
  amount: {
    minHistorySamples: 5,
    lowZ: 2.5,
    highZ: 6,
  },
  velocity: {
    windowMs: 24 * 60 * 60 * 1000, // 24h
    lowCountThreshold: 3,
    highCountThreshold: 8,
    highVolumeMultiple: 5,
    roundTrip: {
      windowMs: 2 * 60 * 60 * 1000, // 2h
      amountTolerancePct: 0.05,
    },
  },
  structuring: {
    // Loosely modeled on the classic $10,000 CTR-style reporting threshold;
    // operator-configurable per environment/asset, not a legal determination.
    threshold: 10_000,
    bandPct: 0.1,
    windowMs: 7 * 24 * 60 * 60 * 1000, // 7d
    minOccurrences: 3,
  },
  newDestination: {
    largeAmountThreshold: 5_000,
    youngAccountMs: 7 * 24 * 60 * 60 * 1000, // 7d
  },
  accountAge: {
    newAccountWindowMs: 7 * 24 * 60 * 60 * 1000, // 7d
  },
  subAccountFanOut: {
    childCountThreshold: 5,
    childDepositConcentrationThreshold: 5,
  },
  referralGraph: {
    firstActionLargeWithdrawalThreshold: 2_000,
  },
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown>
    ? DeepPartial<T[K]>
    : T[K]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Untyped at the recursive core (arbitrary nesting depth), typed only at the
// deepMerge boundary below — a generic constrained to Record<string, unknown>
// doesn't unify cleanly with a fixed-shape interface like ScoringConfig.
function mergeDeep(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const overrideValue = override[key]
    const baseValue = base[key]
    result[key] =
      isPlainObject(overrideValue) && isPlainObject(baseValue)
        ? mergeDeep(baseValue, overrideValue)
        : overrideValue
  }
  return result
}

function deepMerge(
  base: ScoringConfig,
  override: DeepPartial<ScoringConfig> | undefined
): ScoringConfig {
  if (!override) return base
  return mergeDeep(
    base as unknown as Record<string, unknown>,
    override as Record<string, unknown>
  ) as unknown as ScoringConfig
}

// ── Math helpers ──────────────────────────────────────────────────────────

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

// Scales MAD to be comparable to a standard-deviation-based z-score under a
// normal distribution, per the standard "modified z-score" definition.
const MAD_CONSISTENCY_CONSTANT = 0.6745
// Equivalent consistency constant for mean absolute deviation, used only as
// a fallback (see modifiedZScore below).
const MEAN_AD_CONSISTENCY_CONSTANT = 1.253314

/**
 * Modified (MAD-based) z-score of `value` against a historical population.
 * Robust to outliers, unlike a mean/stddev z-score: a few unusually large
 * historical transactions can't numb the model to a new one just like them.
 */
export function modifiedZScore(value: number, population: number[]): number {
  if (population.length === 0) return 0
  const med = median(population)
  const mad = median(population.map((v) => Math.abs(v - med)))

  if (mad !== 0) {
    return (MAD_CONSISTENCY_CONSTANT * (value - med)) / mad
  }

  // MAD is 0 when at least half the population is identical (e.g. an account
  // that always deposits exactly the same amount). Falling back to z=0 here
  // would mean such an account can never trigger an amount anomaly no matter
  // how far a new transaction deviates — fall back to mean absolute deviation
  // instead so a real deviation still registers.
  const meanAbsDev =
    population.reduce((sum, v) => sum + Math.abs(v - med), 0) /
    population.length
  if (meanAbsDev === 0) return value === med ? 0 : Infinity
  return (value - med) / (meanAbsDev * MEAN_AD_CONSISTENCY_CONSTANT)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Linear ramp from 0 (at/below `low`) to 100 (at/above `high`). */
export function linearRamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return value > 0 ? 100 : 0
  if (value <= low) return 0
  if (value >= high) return 100
  return ((value - low) / (high - low)) * 100
}

export function isWithinTolerance(a: number, b: number, pct: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b))
  if (base === 0) return true
  return Math.abs(a - b) / base <= pct
}

function featureResult(
  feature: FeatureCode,
  score: number,
  reasonCodes: string[],
  detail: string
): Omit<FeatureScore, 'weight' | 'contribution'> {
  const clamped = clamp(score, 0, 100)
  return {
    feature,
    score: clamped,
    triggered: clamped > 0,
    reasonCodes,
    detail,
  }
}

const AGENT_EXEMPT_RESULT = (feature: FeatureCode) =>
  featureResult(
    feature,
    0,
    ['AGENT_DRIVEN_EXEMPT'],
    'Agent-initiated transaction (AgentLog-linked) — excluded from this feature.'
  )

// ── Feature: AMOUNT_ANOMALY ─────────────────────────────────────────────

export function computeAmountAnomalyFeature(
  transaction: ScoredTransaction,
  history: HistoricalTransaction[],
  cfg: ScoringConfig['amount']
) {
  const population = history
    .filter(
      (h) =>
        !h.isAgentDriven &&
        h.type === transaction.type &&
        h.assetSymbol === transaction.assetSymbol
    )
    .map((h) => h.amount)

  if (population.length < cfg.minHistorySamples) {
    return featureResult(
      'AMOUNT_ANOMALY',
      0,
      [],
      `Insufficient history (${population.length} sample(s), need ${cfg.minHistorySamples}) to establish a norm.`
    )
  }

  const z = modifiedZScore(transaction.amount, population)
  const absZ = Math.abs(z)
  const score = linearRamp(absZ, cfg.lowZ, cfg.highZ)

  return featureResult(
    'AMOUNT_ANOMALY',
    score,
    score > 0 ? ['AMOUNT_ZSCORE_HIGH'] : [],
    `Modified z-score ${Number.isFinite(absZ) ? absZ.toFixed(2) : 'Infinity'} against ${population.length} historical ${transaction.type} amount(s).`
  )
}

// ── Feature: VELOCITY ────────────────────────────────────────────────────

export function computeVelocityFeature(
  transaction: ScoredTransaction,
  history: HistoricalTransaction[],
  cfg: ScoringConfig['velocity']
) {
  if (transaction.isAgentDriven) return AGENT_EXEMPT_RESULT('VELOCITY')

  const isMoneyMovement = (t: TransactionTypeLike) =>
    t === 'DEPOSIT' || t === 'WITHDRAWAL'
  if (!isMoneyMovement(transaction.type)) {
    return featureResult(
      'VELOCITY',
      0,
      [],
      'Velocity only applies to deposits/withdrawals.'
    )
  }

  const userDriven = history.filter((h) => !h.isAgentDriven)
  const windowStart = transaction.createdAt.getTime() - cfg.windowMs
  const inWindow = userDriven.filter(
    (h) =>
      isMoneyMovement(h.type) &&
      h.assetSymbol === transaction.assetSymbol &&
      h.createdAt.getTime() >= windowStart &&
      h.createdAt.getTime() <= transaction.createdAt.getTime()
  )

  const count = inWindow.length + 1
  const volume =
    inWindow.reduce((sum, h) => sum + h.amount, 0) + transaction.amount

  const historicalAmounts = userDriven
    .filter((h) => isMoneyMovement(h.type))
    .map((h) => h.amount)
  const baselineMedian = median(historicalAmounts)

  const countScore = linearRamp(
    count,
    cfg.lowCountThreshold,
    cfg.highCountThreshold
  )
  const volumeScore =
    baselineMedian > 0
      ? linearRamp(volume / baselineMedian, 1, cfg.highVolumeMultiple)
      : 0

  const oppositeType: TransactionTypeLike | null =
    transaction.type === 'DEPOSIT'
      ? 'WITHDRAWAL'
      : transaction.type === 'WITHDRAWAL'
        ? 'DEPOSIT'
        : null
  const roundTripWindowStart =
    transaction.createdAt.getTime() - cfg.roundTrip.windowMs
  const roundTripMatch = oppositeType
    ? userDriven.find(
        (h) =>
          h.type === oppositeType &&
          h.assetSymbol === transaction.assetSymbol &&
          h.createdAt.getTime() >= roundTripWindowStart &&
          h.createdAt.getTime() <= transaction.createdAt.getTime() &&
          isWithinTolerance(
            h.amount,
            transaction.amount,
            cfg.roundTrip.amountTolerancePct
          )
      )
    : undefined

  const score = Math.max(countScore, volumeScore, roundTripMatch ? 100 : 0)
  const reasonCodes: string[] = []
  if (countScore > 0) reasonCodes.push('VELOCITY_HIGH_FREQUENCY')
  if (volumeScore > 0) reasonCodes.push('VELOCITY_HIGH_VOLUME')
  if (roundTripMatch) reasonCodes.push('VELOCITY_ROUND_TRIP')

  return featureResult(
    'VELOCITY',
    score,
    reasonCodes,
    `${count} deposit/withdrawal(s) totalling ${volume} in the last ${cfg.windowMs}ms` +
      (roundTripMatch
        ? '; matches an opposite-direction transaction of a similar amount within the round-trip window'
        : '.')
  )
}

// ── Feature: STRUCTURING ─────────────────────────────────────────────────

export function computeStructuringFeature(
  transaction: ScoredTransaction,
  history: HistoricalTransaction[],
  cfg: ScoringConfig['structuring']
) {
  if (transaction.isAgentDriven) return AGENT_EXEMPT_RESULT('STRUCTURING')

  if (transaction.type !== 'DEPOSIT' && transaction.type !== 'WITHDRAWAL') {
    return featureResult(
      'STRUCTURING',
      0,
      [],
      'Structuring only applies to deposits/withdrawals.'
    )
  }

  const bandLow = cfg.threshold * (1 - cfg.bandPct)
  const isJustUnder = (amount: number) =>
    amount >= bandLow && amount < cfg.threshold

  if (!isJustUnder(transaction.amount)) {
    return featureResult(
      'STRUCTURING',
      0,
      [],
      `Amount is outside the structuring band (${bandLow}-${cfg.threshold}).`
    )
  }

  const windowStart = transaction.createdAt.getTime() - cfg.windowMs
  const priorOccurrences = history.filter(
    (h) =>
      !h.isAgentDriven &&
      h.type === transaction.type &&
      h.assetSymbol === transaction.assetSymbol &&
      h.createdAt.getTime() >= windowStart &&
      h.createdAt.getTime() <= transaction.createdAt.getTime() &&
      isJustUnder(h.amount)
  ).length

  const occurrences = priorOccurrences + 1
  const score = linearRamp(occurrences, 1, cfg.minOccurrences)

  return featureResult(
    'STRUCTURING',
    score,
    score > 0 ? ['STRUCTURING_SUB_THRESHOLD_PATTERN'] : [],
    `${occurrences} ${transaction.type.toLowerCase()}(s) between ${bandLow} and ${cfg.threshold} within the last ${cfg.windowMs}ms.`
  )
}

// ── Feature: NEW_DESTINATION ─────────────────────────────────────────────

export function computeNewDestinationFeature(
  transaction: ScoredTransaction,
  account: AccountContext,
  cfg: ScoringConfig['newDestination']
) {
  if (!transaction.destinationAddress) {
    return featureResult(
      'NEW_DESTINATION',
      0,
      [],
      'Transaction has no external destination address.'
    )
  }

  if (
    account.knownDestinationAddresses.includes(transaction.destinationAddress)
  ) {
    return featureResult(
      'NEW_DESTINATION',
      0,
      [],
      'Destination has prior history with this account.'
    )
  }

  let score = transaction.amount >= cfg.largeAmountThreshold ? 100 : 60
  const reasonCodes = ['NEW_DESTINATION_NO_HISTORY']

  const destAge = account.destinationAccountAgeMs
  if (destAge != null && destAge < cfg.youngAccountMs) {
    score = 100
    reasonCodes.push('NEW_DESTINATION_YOUNG_ACCOUNT')
  }

  return featureResult(
    'NEW_DESTINATION',
    score,
    reasonCodes,
    `First transaction to this destination${destAge != null ? `; destination account age ${destAge}ms` : ' (destination account age unknown)'}.`
  )
}

// ── Feature: ACCOUNT_AGE ─────────────────────────────────────────────────

export function computeAccountAgeFeature(
  transaction: ScoredTransaction,
  account: AccountContext,
  cfg: ScoringConfig['accountAge']
) {
  const ageMs = Math.max(
    0,
    transaction.createdAt.getTime() - account.accountCreatedAt.getTime()
  )

  if (ageMs >= cfg.newAccountWindowMs) {
    return featureResult(
      'ACCOUNT_AGE',
      0,
      [],
      `Account age ${ageMs}ms is at/beyond the new-account window (${cfg.newAccountWindowMs}ms).`
    )
  }

  // Newer accounts score higher; risk decays linearly to 0 at the window edge.
  const score = 100 * (1 - ageMs / cfg.newAccountWindowMs)

  return featureResult(
    'ACCOUNT_AGE',
    score,
    score > 0 ? ['NEW_ACCOUNT'] : [],
    `Account is ${ageMs}ms old (window: ${cfg.newAccountWindowMs}ms).`
  )
}

// ── Feature: SUB_ACCOUNT_FANOUT ──────────────────────────────────────────

export function computeSubAccountFanOutFeature(
  account: AccountContext,
  cfg: ScoringConfig['subAccountFanOut']
) {
  const sub = account.subAccount
  if (!sub || sub.childCount < cfg.childCountThreshold) {
    return featureResult(
      'SUB_ACCOUNT_FANOUT',
      0,
      [],
      sub
        ? `Child count ${sub.childCount} is below the fan-out threshold (${cfg.childCountThreshold}).`
        : 'Account has no sub-accounts.'
    )
  }

  const score = linearRamp(
    sub.recentChildDepositCount,
    1,
    cfg.childDepositConcentrationThreshold
  )

  return featureResult(
    'SUB_ACCOUNT_FANOUT',
    score,
    score > 0 ? ['SUB_ACCOUNT_FANOUT_MULE_PATTERN'] : [],
    `${sub.childCount} child sub-account(s), ${sub.recentChildDepositCount} recent child deposit(s).`
  )
}

// ── Feature: REFERRAL_GRAPH ──────────────────────────────────────────────

export function computeReferralGraphFeature(
  transaction: ScoredTransaction,
  account: AccountContext,
  cfg: ScoringConfig['referralGraph']
) {
  const referral = account.referral
  if (
    !referral?.isReferred ||
    !referral.isFirstAction ||
    transaction.type !== 'WITHDRAWAL'
  ) {
    return featureResult(
      'REFERRAL_GRAPH',
      0,
      [],
      "Not a referred user's first-action withdrawal."
    )
  }

  const score = linearRamp(
    transaction.amount,
    cfg.firstActionLargeWithdrawalThreshold * 0.5,
    cfg.firstActionLargeWithdrawalThreshold
  )

  return featureResult(
    'REFERRAL_GRAPH',
    score,
    score > 0 ? ['REFERRAL_FIRST_ACTION_LARGE_WITHDRAWAL'] : [],
    `Referred user's first action is a withdrawal of ${transaction.amount}.`
  )
}

// ── Combine ───────────────────────────────────────────────────────────────

/**
 * Score a transaction 0-100 with per-feature reason codes. Deterministic:
 * calling this twice with the same context and config produces an identical
 * result, since nothing here reads the clock, randomness, or external state.
 */
export function scoreTransaction(
  context: TransactionContext,
  configOverrides?: DeepPartial<ScoringConfig>
): ScoringResult {
  const cfg = deepMerge(DEFAULT_SCORING_CONFIG, configOverrides)
  const { transaction, account } = context
  const history = account.transactionHistory

  const raw = [
    computeAmountAnomalyFeature(transaction, history, cfg.amount),
    computeVelocityFeature(transaction, history, cfg.velocity),
    computeStructuringFeature(transaction, history, cfg.structuring),
    computeNewDestinationFeature(transaction, account, cfg.newDestination),
    computeAccountAgeFeature(transaction, account, cfg.accountAge),
    computeSubAccountFanOutFeature(account, cfg.subAccountFanOut),
    computeReferralGraphFeature(transaction, account, cfg.referralGraph),
  ]

  const features: FeatureScore[] = raw.map((f) => {
    const weight = cfg.weights[f.feature]
    return { ...f, weight, contribution: f.score * weight }
  })

  const totalScore = clamp(
    Math.round(features.reduce((sum, f) => sum + f.contribution, 0)),
    0,
    100
  )
  const reasonCodes = features.flatMap((f) => f.reasonCodes)

  return {
    modelVersion: MODEL_VERSION,
    transactionId: transaction.id,
    userId: transaction.userId,
    totalScore,
    features,
    reasonCodes,
  }
}
