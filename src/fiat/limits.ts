/**
 * Fiat Transaction Limits, Velocity Controls & KYC-Tier Enforcement (#362).
 *
 * Pure, side-effect-free evaluation engine that every fiat order creation path
 * (manual on-ramp/off-ramp routes, scheduled fiat purchase jobs, scheduled fiat
 * payout jobs) must pass before an order is created.
 *
 * Key invariants:
 *  1. Compliance freeze (#321) is checked FIRST — a frozen user is denied with
 *     `compliance_freeze` regardless of KYC tier or remaining headroom.
 *  2. Pending orders (`PENDING`, `PROCESSING`) reserve headroom alongside
 *     `SETTLED` orders so rapid-fire concurrent requests cannot bypass limits.
 *  3. Terminal failures (`FAILED`, `REFUNDED`) release headroom as of their
 *     failure/refund timestamp (`updatedAt` / `refundedAt`) without
 *     retroactively rewriting historical windows prior to that timestamp.
 *  4. Rolling windows (1h, 24h, rolling 30d or calendar month) prevent
 *     midnight-reset structuring.
 *  5. Cross-currency orders are converted to the policy's base currency via the
 *     FX feed (`rateSource: 'FX_FEED'`, never assumed 1.0). When the FX feed is
 *     unavailable, cross-currency checks FAIL CLOSED (`fx_unavailable`).
 */

import type { FiatDirection } from './types'

export const KYC_TIERS = ['TIER_0', 'TIER_1', 'TIER_2', 'TIER_3'] as const
export type KycTierValue = (typeof KYC_TIERS)[number]

export type FiatLimitDenialReason =
  | 'compliance_freeze'
  | 'tier_zero'
  | 'per_txn'
  | 'daily'
  | 'monthly'
  | 'velocity_hourly'
  | 'velocity_daily'
  | 'fx_unavailable'

export type FiatLimitWindowName =
  'per_txn' | 'daily' | 'monthly' | 'velocity_hourly' | 'velocity_daily'

export interface DirectionLimitOverrides {
  perTxnMax?: number
  dailyMax?: number
  monthlyMax?: number
  maxTxnsPerHour?: number
  maxTxnsPerDay?: number
}

export interface FiatLimitPolicyConfig {
  tier: KycTierValue
  perTxnMax: number
  dailyMax: number
  monthlyMax: number
  maxTxnsPerHour: number
  maxTxnsPerDay: number
  currency: string
  offRampOverrides?: DirectionLimitOverrides | null
}

export interface HistoricalFiatOrder {
  id?: string
  direction?: FiatDirection
  fiatAmount: number | string | { toNumber?: () => number }
  fiatCurrency: string
  status: string
  createdAt: Date | string
  updatedAt?: Date | string | null
  refundedAt?: Date | string | null
  /** Optional explicit FX rate to policy base currency captured or supplied for this order. */
  fxRateToBase?: number | null
}

export interface FiatLimitWarning {
  window: FiatLimitWindowName
  utilizationPct: number
  used: number
  limit: number
  remaining: number
  currency: string
}

export interface FiatLimitEvaluationResult {
  allowed: boolean
  reason?: FiatLimitDenialReason
  limit?: number
  used?: number
  remaining?: number
  retryAfter?: number
  baseAmount?: number
  baseCurrency?: string
  rateSource?: 'FX_FEED'
  limitWarning?: FiatLimitWarning
}

export interface EvaluateFiatOrderInput {
  userId: string
  direction: FiatDirection
  amount: number
  currency: string
  tier: KycTierValue
  recentOrders: HistoricalFiatOrder[]
  now?: Date
  /** Optional policy override (e.g. loaded from DB `FiatLimitPolicy`). Falls back to seeded tier defaults. */
  policy?: FiatLimitPolicyConfig | null
  /** Optional explicit FX rate (policy baseCurrency units per 1 `currency` unit). Pass `null` to simulate FX outage. */
  fxRate?: number | null
  /** When false, simulates FX feed outage — cross-currency evaluations fail closed with `fx_unavailable`. */
  fxFeedAvailable?: boolean
  /** True when the user is subject to an active #321 compliance freeze or account deactivation. */
  isFrozen?: boolean
  /** Soft warning threshold (0–1). Defaults to `LIMIT_SOFT_WARN_PCT` (0.8). */
  softWarnPct?: number
  /** Monthly window mode: rolling 30 days (default) or UTC calendar month. */
  monthlyWindowMode?: 'rolling_30d' | 'calendar_month'
}

export interface WindowUsageSummary {
  limit: number
  used: number
  remaining: number
  nextResetAt: string
}

export interface FiatLimitsSummary {
  tier: KycTierValue
  direction: FiatDirection
  currency: string
  windows: {
    perTxn: WindowUsageSummary
    daily: WindowUsageSummary
    monthly: WindowUsageSummary
    velocityHourly: WindowUsageSummary
    velocityDaily: WindowUsageSummary
  }
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
export const ROLLING_MONTH_MS = 30 * DAY_MS

/** Soft warning threshold fraction (default 0.80 = 80% of any window limit). */
export const LIMIT_SOFT_WARN_PCT = Number(
  process.env.FIAT_LIMIT_SOFT_WARN_PCT || 0.8
)

/** Consecutive `skipped_limit` runs before a scheduled fiat plan auto-pauses. */
export const SCHEDULED_SKIP_AUTO_PAUSE_THRESHOLD = Number(
  process.env.FIAT_SCHEDULED_SKIP_AUTO_PAUSE_THRESHOLD || 3
)

/**
 * Seeded default policies per KYC tier (#362).
 *
 *  - TIER_0: unverified / view-only ($0 caps across all windows)
 *  - TIER_1: basic verification (small caps, stricter off-ramp)
 *  - TIER_2: standard verification (medium caps)
 *  - TIER_3: enhanced due diligence (high caps)
 */
export const DEFAULT_FIAT_LIMIT_POLICIES: Record<
  KycTierValue,
  FiatLimitPolicyConfig
> = {
  TIER_0: {
    tier: 'TIER_0',
    perTxnMax: 0,
    dailyMax: 0,
    monthlyMax: 0,
    maxTxnsPerHour: 0,
    maxTxnsPerDay: 0,
    currency: 'USD',
    offRampOverrides: null,
  },
  TIER_1: {
    tier: 'TIER_1',
    perTxnMax: 1_000,
    dailyMax: 2_500,
    monthlyMax: 10_000,
    maxTxnsPerHour: 3,
    maxTxnsPerDay: 10,
    currency: 'USD',
    offRampOverrides: {
      perTxnMax: 500,
      dailyMax: 1_000,
      monthlyMax: 5_000,
      maxTxnsPerHour: 2,
      maxTxnsPerDay: 5,
    },
  },
  TIER_2: {
    tier: 'TIER_2',
    perTxnMax: 10_000,
    dailyMax: 25_000,
    monthlyMax: 100_000,
    maxTxnsPerHour: 5,
    maxTxnsPerDay: 20,
    currency: 'USD',
    offRampOverrides: {
      perTxnMax: 5_000,
      dailyMax: 15_000,
      monthlyMax: 50_000,
      maxTxnsPerHour: 4,
      maxTxnsPerDay: 10,
    },
  },
  TIER_3: {
    tier: 'TIER_3',
    perTxnMax: 50_000,
    dailyMax: 100_000,
    monthlyMax: 500_000,
    maxTxnsPerHour: 10,
    maxTxnsPerDay: 50,
    currency: 'USD',
    offRampOverrides: {
      perTxnMax: 25_000,
      dailyMax: 50_000,
      monthlyMax: 250_000,
      maxTxnsPerHour: 6,
      maxTxnsPerDay: 25,
    },
  },
}

/**
 * Reference FX feed table (units of currency per 1 USD), aligned with
 * `src/utils/fxConvert.ts`. Used when converting cross-currency fiat orders
 * into the policy base currency (`rateSource: 'FX_FEED'`).
 */
const FX_UNITS_PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.5,
  CAD: 1.36,
  AUD: 1.53,
  CHF: 0.88,
  CNY: 7.24,
  INR: 83.12,
  BRL: 4.97,
  MXN: 17.05,
  SGD: 1.34,
  HKD: 7.82,
  KRW: 1320.0,
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function toNumericAmount(
  val: number | string | { toNumber?: () => number }
): number {
  if (typeof val === 'number') return val
  if (typeof val === 'string') return Number(val)
  if (val && typeof val.toNumber === 'function') return val.toNumber()
  return Number(val)
}

function toDate(val: Date | string): Date {
  return val instanceof Date ? val : new Date(val)
}

/**
 * Resolve the effective policy for a given tier and direction, applying
 * `offRampOverrides` when `direction === 'OFF_RAMP'`.
 */
export function resolveEffectivePolicy(
  tier: KycTierValue,
  direction: FiatDirection,
  policyOverride?: FiatLimitPolicyConfig | null
): FiatLimitPolicyConfig {
  const base =
    policyOverride ??
    DEFAULT_FIAT_LIMIT_POLICIES[tier] ??
    DEFAULT_FIAT_LIMIT_POLICIES.TIER_0
  if (direction === 'OFF_RAMP' && base.offRampOverrides) {
    const o = base.offRampOverrides
    return {
      ...base,
      perTxnMax: o.perTxnMax ?? base.perTxnMax,
      dailyMax: o.dailyMax ?? base.dailyMax,
      monthlyMax: o.monthlyMax ?? base.monthlyMax,
      maxTxnsPerHour: o.maxTxnsPerHour ?? base.maxTxnsPerHour,
      maxTxnsPerDay: o.maxTxnsPerDay ?? base.maxTxnsPerDay,
    }
  }
  return base
}

/**
 * Convert an amount from `fromCurrency` into `baseCurrency` via the FX feed.
 *
 * Returns `null` when the FX feed is unavailable or either currency is
 * unsupported — callers MUST fail closed (`fx_unavailable`) rather than
 * assuming a 1.0 rate.
 */
export function convertFiatToBaseCurrency(params: {
  amount: number
  fromCurrency: string
  baseCurrency: string
  fxRate?: number | null
  fxFeedAvailable?: boolean
}): { baseAmount: number; rate: number; rateSource: 'FX_FEED' } | null {
  const from = params.fromCurrency.trim().toUpperCase()
  const base = params.baseCurrency.trim().toUpperCase()

  if (from === base) {
    return {
      baseAmount: params.amount,
      rate: 1,
      rateSource: 'FX_FEED',
    }
  }

  // Explicit FX outage signal: fail closed for cross-currency orders.
  if (params.fxFeedAvailable === false || params.fxRate === null) {
    return null
  }

  if (typeof params.fxRate === 'number') {
    if (!Number.isFinite(params.fxRate) || params.fxRate <= 0) {
      return null
    }
    return {
      baseAmount: params.amount * params.fxRate,
      rate: params.fxRate,
      rateSource: 'FX_FEED',
    }
  }

  const fromPerUsd = FX_UNITS_PER_USD[from]
  const basePerUsd = FX_UNITS_PER_USD[base]
  if (fromPerUsd == null || basePerUsd == null || fromPerUsd <= 0) {
    return null
  }

  const rate = basePerUsd / fromPerUsd
  return {
    baseAmount: params.amount * rate,
    rate,
    rateSource: 'FX_FEED',
  }
}

/**
 * Determine whether a historical `FiatOrder` reserves headroom at evaluation
 * instant `now`.
 *
 *  - `PENDING`, `PROCESSING`, `SETTLED`: reserve headroom from `createdAt`.
 *  - `FAILED`, `REFUNDED`: release headroom as of `refundedAt ?? updatedAt`.
 *    If `now` precedes that release timestamp (e.g. point-in-time historical
 *    evaluation before the refund/failure occurred), the order still counted
 *    at `now` — we never retroactively rewrite windows before the release time.
 */
export function doesOrderReserveHeadroom(
  order: HistoricalFiatOrder,
  now: Date
): boolean {
  const createdAt = toDate(order.createdAt)
  if (createdAt.getTime() > now.getTime()) {
    return false
  }

  const status = order.status.toUpperCase()
  if (status === 'PENDING' || status === 'PROCESSING' || status === 'SETTLED') {
    return true
  }

  if (status === 'FAILED' || status === 'REFUNDED') {
    const releaseRaw = order.refundedAt ?? order.updatedAt
    if (releaseRaw) {
      const releaseAt = toDate(releaseRaw)
      // Before the refund/fail timestamp, the order was still active/settled
      // and reserved headroom; at or after `releaseAt`, headroom is released.
      return releaseAt.getTime() > now.getTime()
    }
    return false
  }

  return false
}

function getMonthlyWindowStart(
  now: Date,
  mode: 'rolling_30d' | 'calendar_month'
): Date {
  if (mode === 'calendar_month') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  }
  return new Date(now.getTime() - ROLLING_MONTH_MS)
}

function getMonthlyNextReset(
  oldestInWindow: Date | null,
  now: Date,
  mode: 'rolling_30d' | 'calendar_month'
): Date {
  if (mode === 'calendar_month') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  }
  if (oldestInWindow) {
    return new Date(oldestInWindow.getTime() + ROLLING_MONTH_MS)
  }
  return new Date(now.getTime() + ROLLING_MONTH_MS)
}

/**
 * Pure, deterministic evaluation of a candidate fiat order against KYC-tier
 * limits, rolling velocity counters, pending-order headroom, and compliance
 * freeze status (#362).
 */
export function evaluateFiatOrder(
  input: EvaluateFiatOrderInput
): FiatLimitEvaluationResult {
  const now = input.now ?? new Date()
  const monthlyMode = input.monthlyWindowMode ?? 'rolling_30d'
  const softWarnPct = input.softWarnPct ?? LIMIT_SOFT_WARN_PCT

  // 1. Interaction with #321 freeze: a frozen user is denied regardless of limits.
  if (input.isFrozen) {
    return {
      allowed: false,
      reason: 'compliance_freeze',
      limit: 0,
      used: 0,
      remaining: 0,
    }
  }

  const effectivePolicy = resolveEffectivePolicy(
    input.tier,
    input.direction,
    input.policy
  )

  // 2. TIER_0 (unverified / view-only) check.
  if (
    input.tier === 'TIER_0' ||
    (effectivePolicy.perTxnMax <= 0 &&
      effectivePolicy.dailyMax <= 0 &&
      effectivePolicy.monthlyMax <= 0)
  ) {
    return {
      allowed: false,
      reason: 'tier_zero',
      limit: 0,
      used: 0,
      remaining: 0,
      baseCurrency: effectivePolicy.currency,
    }
  }

  // 3. Convert candidate order amount to the policy base currency via FX feed.
  const candidateFx = convertFiatToBaseCurrency({
    amount: input.amount,
    fromCurrency: input.currency,
    baseCurrency: effectivePolicy.currency,
    fxRate: input.fxRate,
    fxFeedAvailable: input.fxFeedAvailable,
  })
  if (!candidateFx) {
    return {
      allowed: false,
      reason: 'fx_unavailable',
      limit: 0,
      used: 0,
      remaining: 0,
      baseCurrency: effectivePolicy.currency,
    }
  }

  const orderBaseAmount = candidateFx.baseAmount

  // 4. Normalize and filter recent orders that reserve headroom as of `now`.
  const oneHourAgo = new Date(now.getTime() - HOUR_MS)
  const oneDayAgo = new Date(now.getTime() - DAY_MS)
  const monthStart = getMonthlyWindowStart(now, monthlyMode)

  interface NormalizedHistoryOrder {
    createdAt: Date
    baseAmount: number
  }

  const activeOrdersInMonth: NormalizedHistoryOrder[] = []

  for (const raw of input.recentOrders) {
    if (!doesOrderReserveHeadroom(raw, now)) continue
    const createdAt = toDate(raw.createdAt)
    if (createdAt.getTime() < monthStart.getTime()) continue

    const rawAmount = toNumericAmount(raw.fiatAmount)
    const conv = convertFiatToBaseCurrency({
      amount: rawAmount,
      fromCurrency: raw.fiatCurrency,
      baseCurrency: effectivePolicy.currency,
      fxRate:
        raw.fxRateToBase !== undefined
          ? raw.fxRateToBase
          : raw.fiatCurrency.trim().toUpperCase() ===
              input.currency.trim().toUpperCase()
            ? input.fxRate
            : undefined,
      fxFeedAvailable: input.fxFeedAvailable,
    })

    if (!conv) {
      // Fail closed if a counting cross-currency order in the window cannot be valued.
      return {
        allowed: false,
        reason: 'fx_unavailable',
        limit: 0,
        used: 0,
        remaining: 0,
        baseCurrency: effectivePolicy.currency,
      }
    }

    activeOrdersInMonth.push({
      createdAt,
      baseAmount: conv.baseAmount,
    })
  }

  activeOrdersInMonth.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  )

  const hourlyOrders = activeOrdersInMonth.filter(
    (o) => o.createdAt.getTime() > oneHourAgo.getTime()
  )
  const dailyOrders = activeOrdersInMonth.filter(
    (o) => o.createdAt.getTime() > oneDayAgo.getTime()
  )

  const dailyUsed = dailyOrders.reduce((sum, o) => sum + o.baseAmount, 0)
  const monthlyUsed = activeOrdersInMonth.reduce(
    (sum, o) => sum + o.baseAmount,
    0
  )

  // 5. Per-transaction cap check.
  if (orderBaseAmount > effectivePolicy.perTxnMax) {
    return {
      allowed: false,
      reason: 'per_txn',
      limit: effectivePolicy.perTxnMax,
      used: 0,
      remaining: effectivePolicy.perTxnMax,
      baseAmount: roundCurrency(orderBaseAmount),
      baseCurrency: effectivePolicy.currency,
    }
  }

  // 6. Rolling 1-hour velocity check.
  if (hourlyOrders.length + 1 > effectivePolicy.maxTxnsPerHour) {
    const oldest = hourlyOrders[0]?.createdAt ?? now
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest.getTime() + HOUR_MS - now.getTime()) / 1000)
    )
    return {
      allowed: false,
      reason: 'velocity_hourly',
      limit: effectivePolicy.maxTxnsPerHour,
      used: hourlyOrders.length,
      remaining: Math.max(
        0,
        effectivePolicy.maxTxnsPerHour - hourlyOrders.length
      ),
      retryAfter,
      baseAmount: roundCurrency(orderBaseAmount),
      baseCurrency: effectivePolicy.currency,
    }
  }

  // 7. Rolling 24-hour velocity check.
  if (dailyOrders.length + 1 > effectivePolicy.maxTxnsPerDay) {
    const oldest = dailyOrders[0]?.createdAt ?? now
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest.getTime() + DAY_MS - now.getTime()) / 1000)
    )
    return {
      allowed: false,
      reason: 'velocity_daily',
      limit: effectivePolicy.maxTxnsPerDay,
      used: dailyOrders.length,
      remaining: Math.max(
        0,
        effectivePolicy.maxTxnsPerDay - dailyOrders.length
      ),
      retryAfter,
      baseAmount: roundCurrency(orderBaseAmount),
      baseCurrency: effectivePolicy.currency,
    }
  }

  // 8. Rolling 24-hour volume cap check.
  if (dailyUsed + orderBaseAmount > effectivePolicy.dailyMax) {
    const oldest = dailyOrders[0]?.createdAt ?? now
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest.getTime() + DAY_MS - now.getTime()) / 1000)
    )
    return {
      allowed: false,
      reason: 'daily',
      limit: effectivePolicy.dailyMax,
      used: roundCurrency(dailyUsed),
      remaining: roundCurrency(
        Math.max(0, effectivePolicy.dailyMax - dailyUsed)
      ),
      retryAfter,
      baseAmount: roundCurrency(orderBaseAmount),
      baseCurrency: effectivePolicy.currency,
    }
  }

  // 9. Monthly volume cap check.
  if (monthlyUsed + orderBaseAmount > effectivePolicy.monthlyMax) {
    const oldest = activeOrdersInMonth[0]?.createdAt ?? null
    const resetAt = getMonthlyNextReset(oldest, now, monthlyMode)
    const retryAfter = Math.max(
      1,
      Math.ceil((resetAt.getTime() - now.getTime()) / 1000)
    )
    return {
      allowed: false,
      reason: 'monthly',
      limit: effectivePolicy.monthlyMax,
      used: roundCurrency(monthlyUsed),
      remaining: roundCurrency(
        Math.max(0, effectivePolicy.monthlyMax - monthlyUsed)
      ),
      retryAfter,
      baseAmount: roundCurrency(orderBaseAmount),
      baseCurrency: effectivePolicy.currency,
    }
  }

  // 10. Soft warning check (> LIMIT_SOFT_WARN_PCT of any window).
  const candidateWarnings: FiatLimitWarning[] = []
  const newDailyUsed = dailyUsed + orderBaseAmount
  const newMonthlyUsed = monthlyUsed + orderBaseAmount
  const newHourlyCount = hourlyOrders.length + 1
  const newDailyCount = dailyOrders.length + 1

  const checks: Array<{
    window: FiatLimitWindowName
    used: number
    limit: number
  }> = [
    {
      window: 'daily',
      used: roundCurrency(newDailyUsed),
      limit: effectivePolicy.dailyMax,
    },
    {
      window: 'monthly',
      used: roundCurrency(newMonthlyUsed),
      limit: effectivePolicy.monthlyMax,
    },
    {
      window: 'velocity_hourly',
      used: newHourlyCount,
      limit: effectivePolicy.maxTxnsPerHour,
    },
    {
      window: 'velocity_daily',
      used: newDailyCount,
      limit: effectivePolicy.maxTxnsPerDay,
    },
    {
      window: 'per_txn',
      used: roundCurrency(orderBaseAmount),
      limit: effectivePolicy.perTxnMax,
    },
  ]

  for (const c of checks) {
    if (c.limit > 0) {
      const ratio = c.used / c.limit
      if (ratio > softWarnPct) {
        candidateWarnings.push({
          window: c.window,
          utilizationPct: Math.round(ratio * 10000) / 100,
          used: c.used,
          limit: c.limit,
          remaining: roundCurrency(Math.max(0, c.limit - c.used)),
          currency: effectivePolicy.currency,
        })
      }
    }
  }

  // Pick the highest-utilization warning if multiple windows crossed the threshold.
  candidateWarnings.sort((a, b) => b.utilizationPct - a.utilizationPct)

  return {
    allowed: true,
    baseAmount: roundCurrency(orderBaseAmount),
    baseCurrency: effectivePolicy.currency,
    rateSource: candidateFx.rateSource,
    ...(candidateWarnings[0] ? { limitWarning: candidateWarnings[0] } : {}),
  }
}

/**
 * Compute the caller's per-window limit/used/remaining and next reset time
 * for `GET /api/v1/fiat/limits` (#362).
 */
export function computeFiatLimitsSummary(params: {
  tier: KycTierValue
  direction?: FiatDirection
  recentOrders: HistoricalFiatOrder[]
  now?: Date
  policy?: FiatLimitPolicyConfig | null
  monthlyWindowMode?: 'rolling_30d' | 'calendar_month'
  fxRate?: number | null
  fxFeedAvailable?: boolean
}): FiatLimitsSummary {
  const now = params.now ?? new Date()
  const direction = params.direction ?? 'ON_RAMP'
  const monthlyMode = params.monthlyWindowMode ?? 'rolling_30d'
  const effectivePolicy = resolveEffectivePolicy(
    params.tier,
    direction,
    params.policy
  )

  const oneHourAgo = new Date(now.getTime() - HOUR_MS)
  const oneDayAgo = new Date(now.getTime() - DAY_MS)
  const monthStart = getMonthlyWindowStart(now, monthlyMode)

  const activeInMonth: Array<{ createdAt: Date; baseAmount: number }> = []

  for (const raw of params.recentOrders) {
    if (!doesOrderReserveHeadroom(raw, now)) continue
    const createdAt = toDate(raw.createdAt)
    if (createdAt.getTime() < monthStart.getTime()) continue

    const conv = convertFiatToBaseCurrency({
      amount: toNumericAmount(raw.fiatAmount),
      fromCurrency: raw.fiatCurrency,
      baseCurrency: effectivePolicy.currency,
      fxRate: raw.fxRateToBase ?? params.fxRate,
      fxFeedAvailable: params.fxFeedAvailable,
    })
    if (!conv) continue

    activeInMonth.push({ createdAt, baseAmount: conv.baseAmount })
  }

  activeInMonth.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const hourlyOrders = activeInMonth.filter(
    (o) => o.createdAt.getTime() > oneHourAgo.getTime()
  )
  const dailyOrders = activeInMonth.filter(
    (o) => o.createdAt.getTime() > oneDayAgo.getTime()
  )

  const dailyUsed = roundCurrency(
    dailyOrders.reduce((s, o) => s + o.baseAmount, 0)
  )
  const monthlyUsed = roundCurrency(
    activeInMonth.reduce((s, o) => s + o.baseAmount, 0)
  )

  const hourlyResetAt = hourlyOrders[0]
    ? new Date(hourlyOrders[0].createdAt.getTime() + HOUR_MS)
    : new Date(now.getTime() + HOUR_MS)

  const dailyResetAt = dailyOrders[0]
    ? new Date(dailyOrders[0].createdAt.getTime() + DAY_MS)
    : new Date(now.getTime() + DAY_MS)

  const monthlyResetAt = getMonthlyNextReset(
    activeInMonth[0]?.createdAt ?? null,
    now,
    monthlyMode
  )

  return {
    tier: params.tier,
    direction,
    currency: effectivePolicy.currency,
    windows: {
      perTxn: {
        limit: effectivePolicy.perTxnMax,
        used: 0,
        remaining: effectivePolicy.perTxnMax,
        nextResetAt: now.toISOString(),
      },
      daily: {
        limit: effectivePolicy.dailyMax,
        used: dailyUsed,
        remaining: roundCurrency(
          Math.max(0, effectivePolicy.dailyMax - dailyUsed)
        ),
        nextResetAt: dailyResetAt.toISOString(),
      },
      monthly: {
        limit: effectivePolicy.monthlyMax,
        used: monthlyUsed,
        remaining: roundCurrency(
          Math.max(0, effectivePolicy.monthlyMax - monthlyUsed)
        ),
        nextResetAt: monthlyResetAt.toISOString(),
      },
      velocityHourly: {
        limit: effectivePolicy.maxTxnsPerHour,
        used: hourlyOrders.length,
        remaining: Math.max(
          0,
          effectivePolicy.maxTxnsPerHour - hourlyOrders.length
        ),
        nextResetAt: hourlyResetAt.toISOString(),
      },
      velocityDaily: {
        limit: effectivePolicy.maxTxnsPerDay,
        used: dailyOrders.length,
        remaining: Math.max(
          0,
          effectivePolicy.maxTxnsPerDay - dailyOrders.length
        ),
        nextResetAt: dailyResetAt.toISOString(),
      },
    },
  }
}

export interface ScheduledFiatPlanState {
  id: string
  userId: string
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED'
  consecutiveSkippedLimit?: number
}

export interface ScheduledFiatRunEvaluation {
  outcome: 'allowed' | 'skipped_limit'
  evaluation: FiatLimitEvaluationResult
  consecutiveSkippedLimit: number
  shouldAutoPause: boolean
  nextStatus: 'ACTIVE' | 'PAUSED' | 'CANCELLED'
}

/**
 * Evaluate a scheduled fiat purchase / payout run (`fiatPurchases` / `fiatPayouts`).
 *
 * When denied by limits, returns `outcome: 'skipped_limit'` and increments
 * `consecutiveSkippedLimit`. After `maxConsecutiveSkips` (default
 * `SCHEDULED_SKIP_AUTO_PAUSE_THRESHOLD = 3`) consecutive `skipped_limit` runs,
 * transitions `nextStatus` to `'PAUSED'` (`shouldAutoPause: true`) so the
 * caller can auto-pause the plan and notify the user instead of silently
 * no-op'ing forever (#362).
 */
export function evaluateScheduledFiatRun(params: {
  plan: ScheduledFiatPlanState
  evaluationInput: EvaluateFiatOrderInput
  maxConsecutiveSkips?: number
}): ScheduledFiatRunEvaluation {
  const maxSkips =
    params.maxConsecutiveSkips ?? SCHEDULED_SKIP_AUTO_PAUSE_THRESHOLD
  const evaluation = evaluateFiatOrder(params.evaluationInput)

  if (evaluation.allowed) {
    return {
      outcome: 'allowed',
      evaluation,
      consecutiveSkippedLimit: 0,
      shouldAutoPause: false,
      nextStatus: params.plan.status,
    }
  }

  const consecutiveSkippedLimit = (params.plan.consecutiveSkippedLimit ?? 0) + 1
  const shouldAutoPause = consecutiveSkippedLimit >= maxSkips

  return {
    outcome: 'skipped_limit',
    evaluation,
    consecutiveSkippedLimit,
    shouldAutoPause,
    nextStatus: shouldAutoPause ? 'PAUSED' : params.plan.status,
  }
}
