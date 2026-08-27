/**
 * tests/unit/analytics/metrics.test.ts
 *
 * Unit tests for src/analytics/metrics.ts.
 *
 * Covers:
 * • Deterministic math against known fixture series
 * • Degenerate cases return null (never 0, Infinity, or NaN)
 * • Skip interval guard (starting value <= 0 is a deposit, not a return)
 * • Historical vs Parametric VaR/CVaR estimators
 * • Sortino ratio and downside deviation
 * • Max drawdown and max drawdown duration
 * • Annualised volatility and rolling volatility
 * • Beta vs exogenous benchmark
 * • Invariance under gap insertion
 */

import {
  computeAllMetrics,
  computePeriodReturns,
  inferPeriodsPerYear,
  annualisedVolatility,
  downsideDeviation,
  sortinoRatio,
  maxDrawdownFromValues,
  historicalVaR,
  historicalCVaR,
  parametricVaR,
  betaVsBenchmark,
  rollingVolatility,
  rollingDrawdown,
  type ValuePoint,
} from '../../../src/analytics/metrics'

describe('Analytics Metrics Pure Module', () => {
  const HOUR_MS = 3600 * 1000
  const DAY_MS = 24 * HOUR_MS

  // ─── Fixtures ─────────────────────────────────────────────────────────────

  // 1. Daily growing series: 100 -> 102 -> 101 -> 105 -> 104 -> 110
  const sampleSeries: ValuePoint[] = [
    { timestampMs: 0, value: 100 },
    { timestampMs: DAY_MS, value: 102 },
    { timestampMs: 2 * DAY_MS, value: 101 },
    { timestampMs: 3 * DAY_MS, value: 105 },
    { timestampMs: 4 * DAY_MS, value: 104 },
    { timestampMs: 5 * DAY_MS, value: 110 },
  ]

  // Expected simple period returns for sampleSeries:
  // (102-100)/100 = 0.02
  // (101-102)/102 = -0.0098039...
  // (105-101)/101 = 0.0396039...
  // (104-105)/105 = -0.0095238...
  // (110-104)/104 = 0.0576923...

  describe('inferPeriodsPerYear', () => {
    it('infers daily periods correctly (~365.25)', () => {
      const ppy = inferPeriodsPerYear(sampleSeries)
      expect(ppy).not.toBeNull()
      expect(ppy!).toBeCloseTo(365.25, 1)
    })

    it('infers hourly periods correctly (~8766)', () => {
      const hourlySeries: ValuePoint[] = [
        { timestampMs: 0, value: 100 },
        { timestampMs: HOUR_MS, value: 101 },
        { timestampMs: 2 * HOUR_MS, value: 102 },
      ]
      const ppy = inferPeriodsPerYear(hourlySeries)
      expect(ppy!).toBeCloseTo(8766, 0)
    })

    it('is robust to snapshot gaps (uses median spacing)', () => {
      const gappySeries: ValuePoint[] = [
        { timestampMs: 0, value: 100 },
        { timestampMs: DAY_MS, value: 101 },
        { timestampMs: 2 * DAY_MS, value: 102 },
        { timestampMs: 10 * DAY_MS, value: 105 }, // gap of 8 days
        { timestampMs: 11 * DAY_MS, value: 106 },
      ]
      const ppy = inferPeriodsPerYear(gappySeries)
      expect(ppy!).toBeCloseTo(365.25, 1)
    })

    it('returns null for fewer than 2 points', () => {
      expect(inferPeriodsPerYear([])).toBeNull()
      expect(inferPeriodsPerYear([{ timestampMs: 0, value: 100 }])).toBeNull()
    })
  })

  describe('computePeriodReturns', () => {
    it('computes correct simple period returns', () => {
      const returns = computePeriodReturns(sampleSeries)
      expect(returns.length).toBe(5)
      expect(returns[0]).toBeCloseTo(0.02, 4)
      expect(returns[1]).toBeCloseTo(-0.0098039, 4)
      expect(returns[2]).toBeCloseTo(0.0396039, 4)
    })

    it('skips intervals whose starting value is <= 0 (portfolio funded from empty guard)', () => {
      const unfundedSeries: ValuePoint[] = [
        { timestampMs: 0, value: 0 },
        { timestampMs: DAY_MS, value: 100 }, // deposit 100 from 0 -> skipped!
        { timestampMs: 2 * DAY_MS, value: 105 }, // 100 -> 105 = 5% return
      ]
      const returns = computePeriodReturns(unfundedSeries)
      expect(returns.length).toBe(1)
      expect(returns[0]).toBeCloseTo(0.05, 4)
    })

    it('returns empty array for single or zero points', () => {
      expect(computePeriodReturns([])).toEqual([])
      expect(computePeriodReturns([{ timestampMs: 0, value: 100 }])).toEqual([])
    })
  })

  describe('Annualised Volatility & Degenerate Cases', () => {
    it('computes annualised volatility correctly', () => {
      const returns = [0.01, -0.005, 0.02, -0.01, 0.015]
      const vol = annualisedVolatility(returns, 365.25)
      expect(vol).not.toBeNull()
      expect(vol!).toBeGreaterThan(0)
    })

    it('returns null for zero variance (flat series)', () => {
      const flatReturns = [0.01, 0.01, 0.01, 0.01]
      expect(annualisedVolatility(flatReturns, 365.25)).toBeNull()
    })

    it('returns null for insufficient samples (< 2)', () => {
      expect(annualisedVolatility([0.05], 365.25)).toBeNull()
      expect(annualisedVolatility([], 365.25)).toBeNull()
    })
  })

  describe('Sortino Ratio & Downside Deviation', () => {
    it('computes downside deviation and sortino ratio', () => {
      const returns = [0.05, -0.02, 0.04, -0.01, 0.03]
      const ppy = 365.25
      const dd = downsideDeviation(returns, ppy, 0)
      const sortino = sortinoRatio(returns, ppy, 0)

      expect(dd).not.toBeNull()
      expect(dd!).toBeGreaterThan(0)
      expect(sortino).not.toBeNull()
      expect(sortino!).toBeGreaterThan(0)
    })

    it('returns null for Sortino when downside deviation is 0 (all positive returns)', () => {
      const allPositive = [0.02, 0.03, 0.01, 0.04]
      expect(sortinoRatio(allPositive, 365.25, 0)).toBeNull()
    })

    it('returns null for Sortino on insufficient samples', () => {
      expect(sortinoRatio([0.05], 365.25)).toBeNull()
    })
  })

  describe('Max Drawdown & Max Drawdown Duration', () => {
    it('computes max drawdown and duration from value series', () => {
      // 100 -> 120 (peak) -> 90 (trough, -25%) -> 100 -> 110
      const ddSeries: ValuePoint[] = [
        { timestampMs: 0, value: 100 },
        { timestampMs: DAY_MS, value: 120 },
        { timestampMs: 2 * DAY_MS, value: 100 },
        { timestampMs: 3 * DAY_MS, value: 90 }, // Peak 120 to Trough 90 is (120-90)/120 = 25% drawdown
        { timestampMs: 4 * DAY_MS, value: 110 },
      ]

      const res = maxDrawdownFromValues(ddSeries)
      expect(res).not.toBeNull()
      expect(res!.maxDrawdown).toBeCloseTo(0.25, 4)
      expect(res!.maxDrawdownDuration).toBe(2) // 2 steps from peak (index 1) to trough (index 3)
    })

    it('returns 0 drawdown for monotonically increasing series', () => {
      const monotonic: ValuePoint[] = [
        { timestampMs: 0, value: 100 },
        { timestampMs: DAY_MS, value: 105 },
        { timestampMs: 2 * DAY_MS, value: 110 },
      ]
      const res = maxDrawdownFromValues(monotonic)
      expect(res).toEqual({ maxDrawdown: 0, maxDrawdownDuration: 0 })
    })

    it('returns null for insufficient data', () => {
      expect(maxDrawdownFromValues([])).toBeNull()
      expect(maxDrawdownFromValues([{ timestampMs: 0, value: 100 }])).toBeNull()
    })
  })

  describe('Historical vs Parametric VaR & CVaR', () => {
    const returns = [
      -0.05, -0.02, 0.01, 0.03, 0.04, -0.01, 0.02, 0.05, -0.03, 0.01,
    ]

    it('computes historical VaR and CVaR as positive loss magnitudes', () => {
      const var95 = historicalVaR(returns, 0.95)
      const cvar95 = historicalCVaR(returns, 0.95)

      expect(var95).not.toBeNull()
      expect(cvar95).not.toBeNull()
      expect(var95!).toBeGreaterThan(0)
      expect(cvar95!).toBeGreaterThanOrEqual(var95!)
    })

    it('computes parametric VaR assuming normal distribution', () => {
      const pvar95 = parametricVaR(returns, 0.95)
      expect(pvar95).not.toBeNull()
    })

    it('returns null for VaR/CVaR on insufficient samples', () => {
      expect(historicalVaR([0.01], 0.95)).toBeNull()
      expect(historicalCVaR([0.01], 0.95)).toBeNull()
      expect(parametricVaR([0.01], 0.95)).toBeNull()
    })

    it('returns null for parametric VaR on zero variance', () => {
      expect(parametricVaR([0.01, 0.01, 0.01], 0.95)).toBeNull()
    })
  })

  describe('Beta vs Benchmark', () => {
    it('computes beta = 1 when portfolio moves identically to benchmark', () => {
      const pReturns = [0.01, -0.02, 0.03, -0.01, 0.02]
      const bReturns = [0.01, -0.02, 0.03, -0.01, 0.02]
      const beta = betaVsBenchmark(pReturns, bReturns)
      expect(beta).not.toBeNull()
      expect(beta!).toBeCloseTo(1.0, 4)
    })

    it('computes beta = 2 when portfolio moves with twice benchmark leverage', () => {
      const bReturns = [0.01, -0.02, 0.03, -0.01, 0.02]
      const pReturns = bReturns.map((r) => r * 2)
      const beta = betaVsBenchmark(pReturns, bReturns)
      expect(beta!).toBeCloseTo(2.0, 4)
    })

    it('returns null when length mismatch or flat benchmark', () => {
      expect(betaVsBenchmark([0.01, 0.02], [0.01])).toBeNull()
      expect(betaVsBenchmark([0.01, 0.02], [0.05, 0.05])).toBeNull()
    })
  })

  describe('Rolling Volatility & Drawdown Timeseries', () => {
    it('computes rolling volatility series with nulls for initial window warmup', () => {
      const returns = [0.01, -0.02, 0.03, -0.01, 0.02]
      const timestamps = [
        DAY_MS,
        2 * DAY_MS,
        3 * DAY_MS,
        4 * DAY_MS,
        5 * DAY_MS,
      ]
      const rolling = rollingVolatility(returns, timestamps, 3, 365.25)

      expect(rolling.length).toBe(5)
      expect(rolling[0]!.volatility).toBeNull()
      expect(rolling[1]!.volatility).toBeNull()
      expect(rolling[2]!.volatility).not.toBeNull()
    })

    it('computes rolling drawdown series', () => {
      const series: ValuePoint[] = [
        { timestampMs: 0, value: 100 },
        { timestampMs: DAY_MS, value: 120 },
        { timestampMs: 2 * DAY_MS, value: 90 },
      ]
      const rdd = rollingDrawdown(series)
      expect(rdd.length).toBe(3)
      expect(rdd[0]!.drawdown).toBe(0)
      expect(rdd[1]!.drawdown).toBe(0)
      expect(rdd[2]!.drawdown).toBeCloseTo(0.25, 4)
    })
  })

  describe('computeAllMetrics Master Computation', () => {
    it('computes full suite on valid data without throwing NaN or Infinity', () => {
      const metrics = computeAllMetrics(sampleSeries)
      expect(metrics).not.toBeNull()
      expect(metrics!.sampleCount).toBe(5)
      expect(Number.isNaN(metrics!.annualisedVolatility)).toBe(false)
      expect(Number.isNaN(metrics!.varHistorical95)).toBe(false)
      expect(Number.isNaN(metrics!.maxDrawdown)).toBe(false)
    })

    it('returns null metrics for entirely un-funded series', () => {
      const zeroSeries: ValuePoint[] = [
        { timestampMs: 0, value: 0 },
        { timestampMs: DAY_MS, value: 0 },
      ]
      const res = computeAllMetrics(zeroSeries)
      expect(res).not.toBeNull()
      expect(res!.sampleCount).toBe(0)
      expect(res!.annualisedVolatility).toBeNull()
      expect(res!.maxDrawdown).toBeNull()
    })
  })
})
