/**
 * #285 — pure strategy metric computation.
 *
 * The whole point of this module is that a publisher cannot game the
 * leaderboard, so these tests are weighted toward the boundaries where gaming
 * would happen: thin history, degenerate series, and the exact eligibility
 * cutoffs.
 */
import {
  MIN_SAMPLES,
  MIN_TRACK_RECORD_DAYS,
  PortfolioPoint,
  SnapshotRow,
  annualizedReturnPercent,
  bucketByInstant,
  computeStrategyMetrics,
  inferPeriodsPerYear,
  periodReturns,
  sharpeRatio,
} from '../../../src/agent/strategyMetrics'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = new Date('2026-07-25T00:00:00.000Z')

function snap(
  offsetMs: number,
  principal: number,
  yieldAmount: number
): SnapshotRow {
  return {
    snapshotAt: new Date(NOW.getTime() + offsetMs),
    principalAmount: principal,
    yieldAmount,
  }
}

/** An hourly series ending at NOW, values supplied oldest-first. */
function seriesEndingNow(values: number[]): PortfolioPoint[] {
  const n = values.length
  return values.map((value, i) => ({
    at: new Date(NOW.getTime() - (n - 1 - i) * HOUR),
    value,
  }))
}

describe('bucketByInstant', () => {
  it('sums positions sharing an instant into one whole-portfolio point', () => {
    const points = bucketByInstant([
      snap(0, 100, 5),
      snap(0, 200, 10), // second position, same tick
      snap(HOUR, 100, 6),
    ])

    expect(points).toHaveLength(2)
    expect(points[0].value).toBe(315)
    expect(points[1].value).toBe(106)
  })

  it('sorts ascending by time regardless of input order', () => {
    const points = bucketByInstant([snap(2 * HOUR, 100, 0), snap(0, 50, 0)])
    expect(points.map((p) => p.value)).toEqual([50, 100])
  })

  it('drops non-finite values rather than poisoning the series', () => {
    const points = bucketByInstant([snap(0, Number.NaN, 0), snap(HOUR, 100, 0)])
    expect(points).toHaveLength(1)
    expect(points[0].value).toBe(100)
  })

  it('returns an empty series for no snapshots', () => {
    expect(bucketByInstant([])).toEqual([])
  })
})

describe('periodReturns', () => {
  it('differences consecutive values rather than reading a cumulative APY', () => {
    const returns = periodReturns(seriesEndingNow([100, 110, 99]))
    expect(returns).toHaveLength(2)
    expect(returns[0]).toBeCloseTo(0.1, 10)
    expect(returns[1]).toBeCloseTo(-0.1, 10)
  })

  it('skips intervals starting at zero instead of yielding Infinity', () => {
    // A portfolio funded from empty is a deposit, not a return. Letting it
    // through would hand the publisher an unbounded Sharpe.
    const returns = periodReturns(seriesEndingNow([0, 1000, 1010]))
    expect(returns).toHaveLength(1)
    expect(returns[0]).toBeCloseTo(0.01, 10)
    expect(returns.every(Number.isFinite)).toBe(true)
  })

  it('returns nothing for a single point', () => {
    expect(periodReturns(seriesEndingNow([100]))).toEqual([])
  })
})

describe('annualizedReturnPercent', () => {
  it('annualizes a positive return with the simple (non-compounding) convention', () => {
    // +10% over exactly 365.25 days → 10% annualized.
    const points: PortfolioPoint[] = [
      { at: new Date(NOW.getTime() - 365.25 * DAY), value: 100 },
      { at: NOW, value: 110 },
    ]
    expect(annualizedReturnPercent(points)).toBeCloseTo(10, 6)
  })

  it('annualizes a loss as a negative figure', () => {
    const points: PortfolioPoint[] = [
      { at: new Date(NOW.getTime() - 365.25 * DAY), value: 100 },
      { at: NOW, value: 90 },
    ]
    expect(annualizedReturnPercent(points)).toBeCloseTo(-10, 6)
  })

  it('returns 0 for a single point and for a non-positive start', () => {
    expect(annualizedReturnPercent(seriesEndingNow([100]))).toBe(0)
    expect(annualizedReturnPercent(seriesEndingNow([0, 100]))).toBe(0)
  })

  it('does not divide by zero when two points share an instant', () => {
    const points: PortfolioPoint[] = [
      { at: NOW, value: 100 },
      { at: NOW, value: 200 },
    ]
    expect(annualizedReturnPercent(points)).toBe(0)
  })
})

describe('inferPeriodsPerYear', () => {
  it('infers an hourly cadence from an hourly series', () => {
    expect(inferPeriodsPerYear(seriesEndingNow([1, 2, 3, 4]))).toBeCloseTo(
      8766,
      0
    )
  })

  it('uses the median so a single gap does not distort annualization', () => {
    const points: PortfolioPoint[] = [
      { at: new Date(NOW.getTime() - 100 * HOUR), value: 1 },
      { at: new Date(NOW.getTime() - 2 * HOUR), value: 2 },
      { at: new Date(NOW.getTime() - HOUR), value: 3 },
      { at: NOW, value: 4 },
    ]
    expect(inferPeriodsPerYear(points)).toBeCloseTo(8766, 0)
  })

  it('falls back to hourly for a degenerate series', () => {
    expect(inferPeriodsPerYear([])).toBeCloseTo(8766, 0)
    expect(inferPeriodsPerYear(seriesEndingNow([1]))).toBeCloseTo(8766, 0)
  })
})

describe('sharpeRatio', () => {
  it('is null — not zero — for a zero-variance series', () => {
    // A flat portfolio would otherwise divide by a zero stdev and produce
    // Infinity, which sorts straight to the top of the leaderboard.
    expect(sharpeRatio([0.01, 0.01, 0.01, 0.01], 8766)).toBeNull()
  })

  it('is null with fewer than two returns', () => {
    expect(sharpeRatio([], 8766)).toBeNull()
    expect(sharpeRatio([0.01], 8766)).toBeNull()
  })

  it('is null for a non-positive periodsPerYear', () => {
    expect(sharpeRatio([0.01, 0.02, 0.03], 0)).toBeNull()
    expect(sharpeRatio([0.01, 0.02, 0.03], -1)).toBeNull()
  })

  it('is positive for a net-positive return series and negative for a losing one', () => {
    const winning = sharpeRatio([0.01, 0.02, 0.015, 0.012], 8766)
    const losing = sharpeRatio([-0.01, -0.02, -0.015, -0.012], 8766)
    expect(winning).not.toBeNull()
    expect(losing).not.toBeNull()
    expect(winning!).toBeGreaterThan(0)
    expect(losing!).toBeLessThan(0)
  })

  it('lowers the ratio as the risk-free baseline rises', () => {
    const returns = [0.01, 0.02, 0.015, 0.012]
    const atZero = sharpeRatio(returns, 8766, 0)!
    const atFourPercent = sharpeRatio(returns, 8766, 0.04)!
    expect(atFourPercent).toBeLessThan(atZero)
  })

  it('scales by sqrt(periodsPerYear)', () => {
    const returns = [0.01, -0.005, 0.02, 0.001]
    const hourly = sharpeRatio(returns, 8766, 0)!
    const daily = sharpeRatio(returns, 365.25, 0)!
    expect(hourly / daily).toBeCloseTo(Math.sqrt(8766 / 365.25), 6)
  })
})

describe('computeStrategyMetrics — eligibility gate', () => {
  /** An hourly series with `count` points and a little variance. */
  function varyingSeries(count: number): PortfolioPoint[] {
    return seriesEndingNow(
      Array.from({ length: count }, (_, i) => 1000 + i * 3 + (i % 3))
    )
  }

  it('is ineligible with an empty series', () => {
    const metrics = computeStrategyMetrics({ points: [], now: NOW })
    expect(metrics).toMatchObject({
      apy: 0,
      sharpe: null,
      sampleCount: 0,
      trackRecordDays: 0,
      isEligible: false,
    })
  })

  it('reports sharpe as null below MIN_SAMPLES even with a long track record', () => {
    const metrics = computeStrategyMetrics({
      points: varyingSeries(MIN_SAMPLES - 1),
      firstObservedAt: new Date(NOW.getTime() - 200 * DAY),
      now: NOW,
    })
    expect(metrics.sampleCount).toBe(MIN_SAMPLES - 1)
    expect(metrics.sharpe).toBeNull()
    expect(metrics.isEligible).toBe(false)
  })

  it('becomes eligible at exactly MIN_SAMPLES with a sufficient track record', () => {
    const metrics = computeStrategyMetrics({
      points: varyingSeries(MIN_SAMPLES),
      firstObservedAt: new Date(NOW.getTime() - MIN_TRACK_RECORD_DAYS * DAY),
      now: NOW,
    })
    expect(metrics.sampleCount).toBe(MIN_SAMPLES)
    expect(metrics.trackRecordDays).toBe(MIN_TRACK_RECORD_DAYS)
    expect(metrics.sharpe).not.toBeNull()
    expect(metrics.isEligible).toBe(true)
  })

  it('is ineligible one day short of MIN_TRACK_RECORD_DAYS', () => {
    const metrics = computeStrategyMetrics({
      points: varyingSeries(MIN_SAMPLES + 10),
      firstObservedAt: new Date(
        NOW.getTime() - (MIN_TRACK_RECORD_DAYS - 1) * DAY
      ),
      now: NOW,
    })
    expect(metrics.trackRecordDays).toBe(MIN_TRACK_RECORD_DAYS - 1)
    expect(metrics.isEligible).toBe(false)
  })

  it('is ineligible when the series is flat, however long the record', () => {
    // Zero variance → no Sharpe → excluded. A publisher parking funds in a
    // stable position must not rank above one taking real risk.
    const flat = seriesEndingNow(Array.from({ length: 40 }, () => 1000))
    const metrics = computeStrategyMetrics({
      points: flat,
      firstObservedAt: new Date(NOW.getTime() - 200 * DAY),
      now: NOW,
    })
    expect(metrics.sharpe).toBeNull()
    expect(metrics.isEligible).toBe(false)
  })

  it('measures the track record from firstObservedAt, not the windowed series', () => {
    // The 30-day window's oldest sample sits ~30 days back and would floor to
    // 29 — which would make the 30-day leaderboard permanently empty if the
    // track record were derived from the window.
    const points = seriesEndingNow(
      Array.from({ length: 20 }, (_, i) => 1000 + i)
    )
    const metrics = computeStrategyMetrics({
      points,
      firstObservedAt: new Date(NOW.getTime() - 45 * DAY),
      now: NOW,
    })
    expect(metrics.trackRecordDays).toBe(45)
  })

  it('never reports a negative track record for a future firstObservedAt', () => {
    const metrics = computeStrategyMetrics({
      points: varyingSeries(20),
      firstObservedAt: new Date(NOW.getTime() + 10 * DAY),
      now: NOW,
    })
    expect(metrics.trackRecordDays).toBe(0)
    expect(metrics.isEligible).toBe(false)
  })
})
