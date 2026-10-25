/**
 * Rolling beta & market-factor exposure (#352) — pure computation.
 *
 * Measures how much of a portfolio's yield movement is explained by the
 * DeFi-yield "market factor" (the canonical series from `benchmark.ts`) versus
 * idiosyncratic protocol selection, on a rolling window so exposure can be seen
 * CHANGING over time — not just as a single point estimate.
 *
 * Zero I/O, deterministic, fixture-tested. The DB glue that reads
 * YieldSnapshot / ProtocolRate and builds the aligned return series lives in
 * `factorExposureService.ts`; nothing here touches the database or a clock.
 *
 * ─── WHAT "BETA" MEANS HERE ───────────────────────────────────────────────────
 *
 * This is a yield co-movement beta, NOT an asset-price beta. The market factor
 * is the equal/TVL-weighted average of tracked protocol APY returns, and the
 * portfolio series is the same value-derived daily return. A beta of ~1 means
 * "your yield moves with the tracked-protocol market"; of ~0 means "your yield
 * is independent of it". It says nothing about principal loss, depeg, or
 * smart-contract failure. This is stated plainly in the fixed caveat on the
 * API route.
 *
 * ─── OLS MODEL ────────────────────────────────────────────────────────────────
 *
 * Each window regresses portfolio daily return (y) on market daily return (x):
 *
 *   β = Cov(x, y) / Var(x)
 *   α = mean(y) − β · mean(x)
 *   R² = 1 − SS_res / SS_tot
 *
 * Returns are daily fractions (e.g. 0.0003 for +0.03%/day). `alphaAnnualized`
 * is the daily intercept scaled by 365.25 (simple, non-compounding — matches
 * the one-decimal APY convention used across src/analytics).
 *
 * ─── NULL-ON-DEGENERATE (inherited from metrics.ts) ───────────────────────────
 *
 * A window under the sample minimum or with zero market variance returns
 * `null` for every statistic — never 0 (0 would falsely signal "no exposure")
 * and never NaN/Infinity. A beta of exactly 0 is only ever a genuine output.
 */

/** Minimum aligned samples for beta to mean anything — mirrors MIN_ALIGNED_OBSERVATIONS. */
export const MIN_FACTOR_SAMPLES = 14

/**
 * Below this SXX magnitude the market is treated as having NO VARIANCE.
 *
 * Daily returns are bounded fractions (typically ~1e-4), so a genuinely moving
 * market yields SXX well above 1e-8, while an all-but-constant market yields
 * only floating-point jitter (~1e-36). An absolute threshold cleanly separates
 * the two without coupling to the specific series being regressed.
 */
const MIN_MARKET_SXX = 1e-12

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000
const DAYS_PER_YEAR = 365.25

export interface RollingBetaPoint {
  /** UTC ms of the window's last sample. */
  windowEndMs: number
  /** Number of aligned (intersected) samples in the window. */
  sampleCount: number
  /** Null when sampleCount < MIN_FACTOR_SAMPLES or market variance is ~0. */
  beta: number | null
  /** Daily alpha (OLS intercept), null on degenerate. */
  alpha: number | null
  /** Daily alpha annualized (simple, x365.25), null on degenerate. */
  alphaAnnualized: number | null
  /** R² in [0,1], null on degenerate. */
  rSquared: number | null
  /** 1 − R² — the share of yield variance not explained by the market factor. */
  idiosyncraticVolShare: number | null
}

export interface FactorDecomposition {
  /** Full-window sample count. */
  sampleCount: number
  beta: number | null
  /** Daily alpha (OLS intercept). */
  alpha: number | null
  /** Daily alpha annualized (simple, x365.25). */
  alphaAnnualized: number | null
  rSquared: number | null
  /** 1 − R² — "how much of your yield variance is your protocol selection". */
  idiosyncraticVolShare: number | null
}

interface OLSResult {
  beta: number
  alpha: number
  rSquared: number
}

/**
 * Ordinary least squares of y on x with a constant. Returns null when there is
 * no market variance to regress against (denominator ~0) or < 2 points.
 * Never throws, never produces NaN/Infinity.
 */
function ols(xs: number[], ys: number[]): OLSResult | null {
  const n = xs.length
  if (n < 2) return null
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n

  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }

  // Zero (or effectively zero) market variance: regression undefined. The
  // MIN_MARKET_SXX bound rejects floating-point jitter from a constant series.
  if (!(sxx > MIN_MARKET_SXX)) return null

  const beta = sxy / sxx
  const alpha = my - beta * mx

  // Clamp R² into [0,1] against floating-point overshoot. SS_tot can be ~0
  // when the portfolio never moves; treat a constant portfolio as fully
  // explained relative to itself is misleading, so null when there is no
  // portfolio variance to explain either.
  let rSquared: number
  if (syy <= 0) {
    rSquared = 1 // constant portfolio has zero variance to explain
  } else {
    const ssRes = syy - beta * sxy
    rSquared = Math.max(0, Math.min(1, 1 - ssRes / syy))
  }

  return { beta, alpha, rSquared }
}

function annualizeAlpha(dailyAlpha: number): number {
  return dailyAlpha * DAYS_PER_YEAR
}

function toPoint(
  xs: number[],
  ys: number[],
  windowEndMs: number
): RollingBetaPoint {
  const sampleCount = xs.length
  const fit = sampleCount >= MIN_FACTOR_SAMPLES ? ols(xs, ys) : null
  return {
    windowEndMs,
    sampleCount,
    beta: fit?.beta ?? null,
    alpha: fit?.alpha ?? null,
    alphaAnnualized: fit ? annualizeAlpha(fit.alpha) : null,
    rSquared: fit?.rSquared ?? null,
    idiosyncraticVolShare:
      fit && fit.rSquared !== null ? 1 - fit.rSquared : null,
  }
}

export interface RollingBetaInput {
  /** Aligned portfolio daily return series (fractions), same length as marketReturns. */
  portfolioReturns: number[]
  /** Aligned market daily return series (fractions). */
  marketReturns: number[]
  /** Rolling window size in samples (days). Must be <= array length for any windows. */
  windowSize: number
  /** Advance between windows in samples. Defaults to windowSize (non-overlapping). */
  step?: number
  /**
   * Aligned UTC-day-end ms for each sample (same length as the returns). When
   * omitted, windowEndMs falls back to the 1-indexed sample position (index+1).
   */
  timestampsMs?: number[]
}

/**
 * Rolling OLS beta of portfolio returns on market returns, advanced by `step`
 * samples per window. Always returns at least the summary when the arrays are
 * non-empty; under-sampled or zero-variance windows carry all-null statistics.
 */
export function rollingBeta(input: RollingBetaInput): RollingBetaPoint[] {
  const step = input.step ?? input.windowSize
  const n = input.portfolioReturns.length
  const out: RollingBetaPoint[] = []

  if (step <= 0 || input.windowSize <= 0) return out
  if (n === 0 || n !== input.marketReturns.length) return out

  const ts = input.timestampsMs

  for (let start = 0; start + input.windowSize <= n; start += step) {
    const end = start + input.windowSize - 1
    const xs = input.marketReturns.slice(start, start + input.windowSize)
    const ys = input.portfolioReturns.slice(start, start + input.windowSize)
    const windowEndMs = ts ? ts[end] : end + 1
    out.push(toPoint(xs, ys, windowEndMs))
  }

  return out
}

export interface FactorDecompositionInput {
  /** Aligned portfolio daily return series. */
  portfolioReturns: number[]
  /** Aligned market daily return series. */
  marketReturns: number[]
}

/**
 * Full-window factor decomposition (single OLS over the whole aligned series).
 * Degenerate inputs return null statistics with the sample count preserved so
 * callers can explain _why_.
 */
export function factorDecomposition(
  input: FactorDecompositionInput
): FactorDecomposition {
  // Intersect the two series by truncating to the shorter length — the pure
  // core receives index-aligned series already; mismatched lengths here are a
  // defensive truncation, never a zero-fill.
  const aligned = Math.min(
    input.portfolioReturns.length,
    input.marketReturns.length
  )

  const xs = input.marketReturns.slice(0, aligned)
  const ys = input.portfolioReturns.slice(0, aligned)

  const fit = aligned >= MIN_FACTOR_SAMPLES ? ols(xs, ys) : null

  return {
    sampleCount: aligned,
    beta: fit?.beta ?? null,
    alpha: fit?.alpha ?? null,
    alphaAnnualized: fit ? annualizeAlpha(fit.alpha) : null,
    rSquared: fit?.rSquared ?? null,
    idiosyncraticVolShare:
      fit && fit.rSquared !== null ? 1 - fit.rSquared : null,
  }
}
