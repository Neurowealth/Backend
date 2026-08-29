/**
 * Grounded, fee- and slippage-aware rebalance cost model (#347).
 *
 * Replaces the stubbed `estimateRebalanceCosts` (which hardcoded gas at $0.50,
 * divided by 1e18 as a wei assumption, and capped slippage at a flat 0.25%).
 * This model derives the cost of a specific move from a live base-fee oracle
 * and a DEX path simulation, with an explicit fallback confidence level when
 * either is unavailable. Purely computed — zero I/O — so the numbers that gate
 * a real-money move are unit-testable in isolation.
 *
 * ─── AMOUNT MATH ─────────────────────────────────────────────────────────────
 *
 * The old model did `parseInt(amount) / 1e18`, an ERC-20 wei assumption that
 * does not match this platform's Decimal(36,18) token amounts. Here the move
 * amount is always a Decimal string divided by the ASSET'S REAL decimals
 * (`amount / 10^assetDecimals`) to get human units, then multiplied by the
 * asset's USD price to get a USD value against which fees are measured.
 *
 * ─── NETWORK FEE ─────────────────────────────────────────────────────────────
 *
 * `networkFeeStroops = feeSnapshot.recommendedBaseFee * opsInRebalance`.
 * Stroops → XLM: 1 XLM = 1e7 stroops. XLM → USD via `xlmUsd`.
 * `networkFeePctOfAmount = networkFeeUsd / amountUsd * 100`.
 *
 * When the fee oracle is missing or stale (fetchedAt older than
 * FEE_SNAPSHOT_MAX_AGE_MS), we fall back to `NETWORK_FEE_FALLBACK_USD` and mark
 * `dataConfidence: 'fallback'`. An unavailable oracle NEVER lowers the modeled
 * cost — it raises it via conservative fallback constants, so a blind decision
 * is more reluctant, not less.
 *
 * ─── PRICE IMPACT ────────────────────────────────────────────────────────────
 *
 * `priceImpactBps` comes from an actual path simulation for the concrete swap.
 * For a same-asset rebalance (no conversion) it is 0. When a cross-asset move
 * has no simulation, `PRICE_IMPACT_FALLBACK_BPS` applies and confidence drops
 * to 'fallback'. A large move that would move the book is penalized and may be
 * rejected — that is the point.
 *
 * ─── PER-PROTOCOL ENTRY/EXIT ─────────────────────────────────────────────────
 *
 * `protocolEntryExitBps` is a configurable per-protocol entry+exit cost map,
 * indexed by protocol name (bps). Absent entries contribute 0.
 */

// ── Tunables (mirror docs/ASSUMPTIONS.md / the #347 issue) ───────────────────

/** Staleness bound for a fee oracle snapshot. Beyond this, use fallback. */
export const FEE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000

/** Fallback network-fee (USD) used when the fee oracle is unavailable/stale. */
export const NETWORK_FEE_FALLBACK_USD = 0.5

/** Default USD value of one XLM, used to convert stroop fees to USD. */
export const DEFAULT_XLM_USD = 0.1

/** CPI-safe assumption: when an asset has no USD price, treat it as $1 (stablecoin). */
export const DEFAULT_ASSET_USD = 1

/** Fallback price impact (bps) for a cross-asset move with no simulation. */
export const PRICE_IMPACT_FALLBACK_BPS = 25

/** Max payback horizon for a rebalance move (see computePaybackDays). */
export const REBALANCE_MAX_PAYBACK_DAYS = 21

/** Congestion premium multiplier applied to the payback horizon when congested. */
export const REBALANCE_CONGESTION_PREMIUM = 0.5

const XLMS_PER_STROOP = 1e-7

export interface FeeSnapshot {
  /** Recommended base fee, in stroops. */
  recommendedBaseFee: number
  /** 'low' | 'medium' | 'high' — congestion of the network. */
  congestionLevel?: 'low' | 'medium' | 'high'
  /** When the oracle produced this snapshot; null means not applicable. */
  fetchedAt?: Date | null
}

export interface RebalanceCostInput {
  fromProtocol: string
  toProtocol: string
  /**
   * The move amount as a Decimal string in the ASSET's raw unit (e.g. the
   * Decimal(36,18) column). Converted with `assetDecimals`, never /1e18.
   */
  amount: string
  assetSymbol?: string
  /** Real decimals of the asset. e.g. 7 (XLM), 6 (USDC), 18 (ERC-20). */
  assetDecimals?: number
  /** USD value of one human unit of the asset. Defaults to $1 (stablecoin). */
  assetUsd?: number
  /** USD value of one XLM. Defaults to DEFAULT_XLM_USD. */
  xlmUsd?: number
  /** Live fee-oracle snapshot, or undefined to force fallback. */
  feeSnapshot?: FeeSnapshot | null
  /**
   * Simulated price impact in bps for the concrete swap, or undefined when
   * unavailable. 0 for a same-asset move (no conversion).
   */
  priceImpactBps?: number
  /** True when `from` and `to` hold the same asset (no DEX conversion). */
  sameAsset?: boolean
  /** Per-protocol entry+exit cost in bps, keyed by protocol name. */
  protocolEntryExitBps?: Record<string, number>
  /** Number of on-chain operations a rebalance requires. Default 1. */
  opsInRebalance?: number
}

export interface RebalanceCostBreakdown {
  networkFeeStroops: number
  networkFeeUsd: number
  networkFeePctOfAmount: number
  priceImpactBps: number
  priceImpactPct: number
  protocolEntryExitBps: number
  protocolEntryExitPct: number
  totalCostPct: number
}

export interface RebalanceCost {
  networkFeeStroops: number
  networkFeePctOfAmount: number
  priceImpactBps: number
  protocolEntryExitBps: number
  totalCostPct: number
  breakdown: RebalanceCostBreakdown
  /** 'measured' = live oracle used; 'fallback' = at least one constant used. */
  dataConfidence: 'measured' | 'fallback'
  /** Components that forced the fallback confidence, when any. */
  fallbackReasons: string[]
}

const EPSILON = 1e-12

/** Convert a Decimal-string amount + decimals to human units. */
export function amountToHumanUnits(
  amount: string,
  decimals: number = 18
): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n / Math.pow(10, decimals)
}

/** Compute USD value of the move from human units and a per-unit price. */
export function amountToUsd(
  amountHuman: number,
  assetUsd: number = DEFAULT_ASSET_USD
): number {
  return amountHuman * assetUsd
}

/**
 * Estimate the full cost of a rebalance move.
 *
 * Returns the cost components plus a confidence level. When any component had
 * to fall back to a constant (fee oracle missing/stale, no price-impact
 * simulation), `dataConfidence` is 'fallback' and the caller is expected to
 * raise its threshold — never lower it.
 */
export function estimateRebalanceCost(
  input: RebalanceCostInput
): RebalanceCost {
  const ops = input.opsInRebalance ?? 1
  const fallbackReasons: string[] = []

  // ── Network fee in stroops ─────────────────────────────────────────────────
  let networkFeeStroops: number
  let networkFeeUsd: number
  let useLiveFee = false

  const snapshot = input.feeSnapshot
  const stale =
    !snapshot ||
    !Number.isFinite(snapshot.recommendedBaseFee) ||
    (snapshot.fetchedAt !== undefined &&
      snapshot.fetchedAt !== null &&
      Date.now() - snapshot.fetchedAt.getTime() > FEE_SNAPSHOT_MAX_AGE_MS)

  if (!stale) {
    networkFeeStroops = snapshot!.recommendedBaseFee * ops
    const xlmFee = networkFeeStroops * XLMS_PER_STROOP
    networkFeeUsd = xlmFee * (input.xlmUsd ?? DEFAULT_XLM_USD)
    useLiveFee = true
  } else {
    networkFeeStroops =
      (NETWORK_FEE_FALLBACK_USD /
        (input.xlmUsd ?? DEFAULT_XLM_USD) /
        XLMS_PER_STROOP) *
      ops
    networkFeeUsd = NETWORK_FEE_FALLBACK_USD
    fallbackReasons.push(
      snapshot ? 'fee_oracle_stale_or_invalid' : 'fee_oracle_unavailable'
    )
  }

  const amountHuman = amountToHumanUnits(
    input.amount,
    input.assetDecimals ?? 18
  )
  const amountUsd = amountToUsd(amountHuman, input.assetUsd)
  const networkFeePctOfAmount =
    amountUsd > 0 ? (networkFeeUsd / amountUsd) * 100 : 0

  // ── Price impact ───────────────────────────────────────────────────────────
  let priceImpactBps: number
  if (input.sameAsset) {
    priceImpactBps = 0
  } else if (
    typeof input.priceImpactBps === 'number' &&
    Number.isFinite(input.priceImpactBps)
  ) {
    priceImpactBps = input.priceImpactBps
  } else {
    priceImpactBps = PRICE_IMPACT_FALLBACK_BPS
    fallbackReasons.push('price_impact_unavailable')
  }
  const priceImpactPct = priceImpactBps / 100

  // ── Per-protocol entry/exit ────────────────────────────────────────────────
  const entryExitBps =
    (input.protocolEntryExitBps?.[input.fromProtocol] ?? 0) +
    (input.protocolEntryExitBps?.[input.toProtocol] ?? 0)
  const protocolEntryExitPct = entryExitBps / 100

  const totalCostPct =
    networkFeePctOfAmount + priceImpactPct + protocolEntryExitPct

  return {
    networkFeeStroops,
    networkFeePctOfAmount,
    priceImpactBps,
    protocolEntryExitBps: entryExitBps,
    totalCostPct,
    breakdown: {
      networkFeeStroops,
      networkFeeUsd,
      networkFeePctOfAmount,
      priceImpactBps,
      priceImpactPct,
      protocolEntryExitBps: entryExitBps,
      protocolEntryExitPct,
      totalCostPct,
    },
    dataConfidence:
      useLiveFee && fallbackReasons.length === 0 ? 'measured' : 'fallback',
    fallbackReasons,
  }
}

/**
 * Annualized benefit of the move, as a fraction (e.g. 0.03 = 3 percentage
 * points). The payback gate uses this APY delta ONLY — goal/target strategies
 * keep their own logic; this is a floor for every move, not the whole decision.
 */
export function annualizedBenefitPct(fromApy: number, toApy: number): number {
  return toApy - fromApy
}

/**
 * Days to recoup the modeled cost at the improved rate.
 *
 *   benefitPerDayPct = annualizedBenefitPct / 365
 *   paybackDays      = totalCostPct / benefitPerDayPct
 *
 * Returns Infinity (never recoups) when the benefit is non-positive.
 */
export function computePaybackDays(
  totalCostPct: number,
  benefitPct: number
): number {
  if (benefitPct <= EPSILON) return Infinity
  const benefitPerDayPct = benefitPct / 365
  return totalCostPct / benefitPerDayPct
}

/**
 * Whether the move clears the payback gate.
 *
 * costPct / annualizedBenefitPct must recoup within REBALANCE_MAX_PAYBACK_DAYS.
 * Under elevated congestion ('high') we are MORE reluctant to trade: the
 * congestion premium shrinks the acceptable horizon (fewer days allowed), so a
 * move is held to a stricter standard precisely when fees are elevated.
 */
export function passesPaybackGate(
  cost: RebalanceCost,
  fromApy: number,
  toApy: number,
  congestionLevel?: 'low' | 'medium' | 'high',
  overrides?: { maxPaybackDays?: number; congestionPremium?: number }
): { paybackDays: number; allowed: boolean; reason: string } {
  const maxPaybackDays = overrides?.maxPaybackDays ?? REBALANCE_MAX_PAYBACK_DAYS
  const premium = overrides?.congestionPremium ?? REBALANCE_CONGESTION_PREMIUM

  const benefitPct = annualizedBenefitPct(fromApy, toApy)
  const paybackDays = computePaybackDays(cost.totalCostPct, benefitPct)

  // Higher congestion → smaller effective horizon → stricter.
  const effectiveMax =
    congestionLevel === 'high'
      ? Math.max(0, maxPaybackDays * (1 - premium))
      : congestionLevel === 'medium'
        ? Math.max(0, maxPaybackDays * (1 - premium / 2))
        : maxPaybackDays

  if (benefitPct <= EPSILON) {
    return {
      paybackDays,
      allowed: false,
      reason: 'No positive APY benefit — move would not recoup its cost',
    }
  }

  const allowed = paybackDays < effectiveMax
  return {
    paybackDays,
    allowed,
    reason: allowed
      ? `Recoups cost in ${paybackDays.toFixed(1)} days (within ${effectiveMax.toFixed(1)})`
      : `Takes ${paybackDays.toFixed(1)} days to recoup cost, beyond ${effectiveMax.toFixed(1)} allowed`,
  }
}
