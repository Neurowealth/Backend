/**
 * Pure-core tests for src/analytics/factorExposure.ts (#352).
 *
 * Fixture series exercise the three canonical cases required by the issue:
 *   - independent series → beta ≈ 0, R² ≈ 0
 *   - portfolio == market → beta ≈ 1, R² ≈ 1
 *   - degenerate (under-sampled / zero market variance) → all-null, never NaN
 * Plus rolling-window mechanics (intersected slices, step, windowEndMs).
 */

import {
  rollingBeta,
  factorDecomposition,
  MIN_FACTOR_SAMPLES,
  RollingBetaPoint,
} from '../../../src/analytics/factorExposure'

/** N daily-return-style points that move but are independent of `x`. */
function independentY(xs: number[], scale = 1e-4, offset = 0.001): number[] {
  return xs.map((_, i) => Math.sin(i * 1.7) * scale + offset)
}

describe('factorDecomposition', () => {
  it('portfolio == market → beta ≈ 1 and R² ≈ 1', () => {
    const market = Array.from(
      { length: 60 },
      (_, i) => 0.0002 + 0.0001 * Math.sin(i)
    )
    const portfolio = market.map((m) => m + 0) // identical
    const d = factorDecomposition({
      portfolioReturns: portfolio,
      marketReturns: market,
    })
    expect(d.beta).not.toBeNull()
    expect(Math.abs(d.beta! - 1)).toBeLessThan(1e-9)
    expect(d.rSquared).not.toBeNull()
    expect(d.rSquared!).toBeGreaterThan(0.9999)
    expect(d.idiosyncraticVolShare!).toBeLessThan(1e-4)
  })

  it('independent series → beta ≈ 0 and R² ≈ 0', () => {
    const market = Array.from(
      { length: 60 },
      (_, i) => 0.0002 + 0.0001 * Math.sin(i)
    )
    const portfolio = independentY(market)
    const d = factorDecomposition({
      portfolioReturns: portfolio,
      marketReturns: market,
    })
    expect(d.beta).not.toBeNull()
    expect(Math.abs(d.beta!)).toBeLessThan(0.5)
    expect(d.rSquared!).toBeLessThan(0.4)
  })

  it('portfolio is a fixed multiple of market → beta ≈ that multiple', () => {
    const market = Array.from(
      { length: 60 },
      (_, i) => 0.0002 + 0.0003 * Math.sin(i)
    )
    // beta = 2 (portfolio moves twice as much as the market)
    const portfolio = market.map((m) => 2 * m)
    const d = factorDecomposition({
      portfolioReturns: portfolio,
      marketReturns: market,
    })
    expect(Math.abs(d.beta! - 2)).toBeLessThan(1e-9)
    expect(d.rSquared!).toBeGreaterThan(0.9999)
  })

  it('alpha annualizes the daily intercept (simple, x365.25)', () => {
    const market = Array.from(
      { length: 60 },
      (_, i) => 0.0002 + 0.0001 * Math.sin(i)
    )
    // portfolio = market + 0.0001 fixed daily excess -> alpha = 0.0001
    const portfolio = market.map((m) => m + 0.0001)
    const d = factorDecomposition({
      portfolioReturns: portfolio,
      marketReturns: market,
    })
    expect(d.alpha).not.toBeNull()
    expect(Math.abs(d.alpha! - 0.0001)).toBeLessThan(1e-12)
    expect(Math.abs(d.alphaAnnualized! - 0.0001 * 365.25)).toBeLessThan(1e-8)
  })

  it('under-sampled series → all-null statistics, finite sampleCount', () => {
    const market = Array.from({ length: 5 }, (_, i) => 0.0001 * (i + 1))
    const d = factorDecomposition({
      portfolioReturns: market.map(() => 0.001),
      marketReturns: market,
    })
    expect(d.sampleCount).toBe(5)
    expect(d.beta).toBeNull()
    expect(d.alpha).toBeNull()
    expect(d.alphaAnnualized).toBeNull()
    expect(d.rSquared).toBeNull()
    expect(d.idiosyncraticVolShare).toBeNull()
  })

  it('zero market variance → all-null beta, never NaN', () => {
    const market = Array.from({ length: 60 }, () => 0.0003) // constant market
    const portfolio = Array.from({ length: 60 }, (_, i) => 0.0001 * i)
    const d = factorDecomposition({
      portfolioReturns: portfolio,
      marketReturns: market,
    })
    expect(Number.isNaN(d.beta as number)).toBe(false)
    expect(d.beta).toBeNull()
    expect(d.rSquared).toBeNull()
    expect(Number.isFinite(d.sampleCount)).toBe(true)
  })

  it('mismatched lengths are intersected (truncated), not error-thrown', () => {
    const market = Array.from({ length: 60 }, (_, i) => 0.0001 * (i + 1))
    const portfolio = Array.from({ length: 40 }, (_, i) => 0.0001 * (i + 1))
    const d = factorDecomposition({
      portfolioReturns: portfolio,
      marketReturns: market,
    })
    expect(d.sampleCount).toBe(40)
  })
})

describe('rollingBeta', () => {
  const market = Array.from(
    { length: 60 },
    (_, i) => 0.0002 + 0.0001 * Math.sin(i)
  )

  it('returns one point per non-overlapping window when step == windowSize', () => {
    const ref = market // portfolio == market
    const out = rollingBeta({
      portfolioReturns: ref,
      marketReturns: market,
      windowSize: 30,
      step: 30,
    })
    // 60 samples / 30 = 2 full windows
    expect(out).toHaveLength(2)
    for (const p of out) {
      expect(p.sampleCount).toBe(30)
      expect(p.beta).not.toBeNull()
    }
  })

  it('with timestamps, windowEndMs is the last sample of each window', () => {
    const ts = market.map((_, i) => (i + 1) * 86400000)
    const out = rollingBeta({
      portfolioReturns: market,
      marketReturns: market,
      windowSize: 30,
      step: 30,
      timestampsMs: ts,
    })
    expect(out[0].windowEndMs).toBe(ts[29])
    expect(out[1].windowEndMs).toBe(ts[59])
  })

  it('overlapping windows when step < windowSize', () => {
    const out = rollingBeta({
      portfolioReturns: market,
      marketReturns: market,
      windowSize: 40,
      step: 10,
    })
    // windows: [0,40) [10,50) [20,60) = 3
    expect(out).toHaveLength(3)
  })

  it('a rollingWindow that leaves < 2 windows → < 2 points (caller folds to summary)', () => {
    // 60 samples, window 40 -> only 1 non-overlapping window
    const out = rollingBeta({
      portfolioReturns: market,
      marketReturns: market,
      windowSize: 40,
      step: 40,
    })
    expect(out).toHaveLength(1)
  })

  it('degenerate window (zero market variance) → null beta, not NaN', () => {
    const flatMarket = Array.from({ length: 60 }, () => 0.0003)
    const mover = Array.from({ length: 60 }, (_, i) => 0.0001 * i)
    const out = rollingBeta({
      portfolioReturns: mover,
      marketReturns: flatMarket,
      windowSize: 30,
      step: 30,
    })
    expect(out.length).toBe(2)
    for (const p of out) {
      expect(Number.isNaN(p.beta as number)).toBe(false)
      expect(p.beta).toBeNull()
      expect(p.rSquared).toBeNull()
    }
  })

  it('under-sampled window (< MIN_FACTOR_SAMPLES) → null beta', () => {
    const out = rollingBeta({
      portfolioReturns: market,
      marketReturns: market,
      windowSize: MIN_FACTOR_SAMPLES - 1,
    })
    // 60 samples / 13 = 4 non-overlapping windows, each under-sampled.
    expect(out.length).toBe(4)
    expect(out[0].sampleCount).toBe(MIN_FACTOR_SAMPLES - 1)
    expect(out[0].beta).toBeNull()
  })

  it('empty input returns no windows', () => {
    const out = rollingBeta({
      portfolioReturns: [],
      marketReturns: [],
      windowSize: 30,
    })
    expect(out).toEqual([])
  })

  it('shapes are stable and finite', () => {
    const out: RollingBetaPoint[] = rollingBeta({
      portfolioReturns: market.map((m) => m),
      marketReturns: market.map((m) => m),
      windowSize: 30,
      step: 30,
      timestampsMs: market.map((_, i) => (i + 1) * 86400000),
    })
    const p = out[0]
    expect(Number.isFinite(p.windowEndMs)).toBe(true)
    expect(p.alphaAnnualized).not.toBeNull()
    expect(p.idiosyncraticVolShare).not.toBeNull()
  })
})
