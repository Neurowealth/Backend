import {
  computeRiskScore,
  computeApyVolatilityFactor,
  computeTvlTrendFactor,
  computeAgeFactor,
  filterToWindow,
  RateSample,
  MIN_SAMPLES_FOR_HISTORY,
  TRAILING_WINDOW_DAYS,
  APY_STDEV_FLOOR,
  AGE_SATURATION_DAYS,
  INSUFFICIENT_HISTORY_SCORE,
  WEIGHTS,
} from '../../../src/agent/riskScoring'

const DAY_MS = 24 * 60 * 60 * 1000

// Fixed reference "now" so every fixture is deterministic.
const NOW = new Date('2026-07-16T00:00:00.000Z')

/** Build a sample `daysAgo` before NOW. */
function sample(
  daysAgo: number,
  supplyApy: number,
  tvl: number | null = 1_000_000
): RateSample {
  return {
    supplyApy,
    tvl,
    fetchedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
  }
}

describe('riskScoring — weights invariant', () => {
  it('component weights sum to 1', () => {
    const sum =
      WEIGHTS.audit + WEIGHTS.volatility + WEIGHTS.tvlTrend + WEIGHTS.age
    expect(sum).toBeCloseTo(1, 10)
  })
})

describe('filterToWindow', () => {
  it('keeps only samples within the trailing window and sorts ascending by time', () => {
    const samples = [
      sample(1, 5),
      sample(TRAILING_WINDOW_DAYS + 5, 5), // outside window — dropped
      sample(10, 5),
    ]
    const windowed = filterToWindow(samples, NOW)
    expect(windowed).toHaveLength(2)
    // Ascending order: the 10-days-ago sample comes before the 1-day-ago one.
    expect(windowed[0].fetchedAt.getTime()).toBeLessThan(
      windowed[1].fetchedAt.getTime()
    )
  })
})

describe('computeApyVolatilityFactor', () => {
  it('returns 1 for a perfectly stable APY', () => {
    const samples = [sample(3, 5), sample(2, 5), sample(1, 5)]
    expect(computeApyVolatilityFactor(samples)).toBe(1)
  })

  it('returns a lower factor as APY volatility increases', () => {
    const stable = [sample(3, 5), sample(2, 5.1), sample(1, 4.9)]
    const volatile = [sample(3, 1), sample(2, 9), sample(1, 5)]
    expect(computeApyVolatilityFactor(volatile)).toBeLessThan(
      computeApyVolatilityFactor(stable)
    )
  })

  it('floors at 0 once stdev reaches APY_STDEV_FLOOR', () => {
    // Two points at +/- APY_STDEV_FLOOR around the mean → stdev == APY_STDEV_FLOOR.
    const samples = [
      sample(2, 10 - APY_STDEV_FLOOR),
      sample(1, 10 + APY_STDEV_FLOOR),
    ]
    expect(computeApyVolatilityFactor(samples)).toBe(0)
  })

  it('returns 0 when fewer than two APY points exist', () => {
    expect(computeApyVolatilityFactor([sample(1, 5)])).toBe(0)
  })
})

describe('computeTvlTrendFactor', () => {
  it('is > 0.5 when TVL is growing across the window', () => {
    const samples = [
      sample(3, 5, 1_000_000),
      sample(2, 5, 1_100_000),
      sample(1, 5, 1_200_000),
    ]
    expect(computeTvlTrendFactor(samples)).toBeGreaterThan(0.5)
  })

  it('is < 0.5 when TVL is declining across the window', () => {
    const samples = [
      sample(3, 5, 1_200_000),
      sample(2, 5, 1_000_000),
      sample(1, 5, 800_000),
    ]
    expect(computeTvlTrendFactor(samples)).toBeLessThan(0.5)
  })

  it('is neutral (0.5) when there is no usable TVL data', () => {
    const samples = [sample(3, 5, null), sample(2, 5, null), sample(1, 5, null)]
    expect(computeTvlTrendFactor(samples)).toBe(0.5)
  })
})

describe('computeAgeFactor', () => {
  it('is 0 at age 0 and saturates to 1 at AGE_SATURATION_DAYS', () => {
    expect(computeAgeFactor(0)).toBe(0)
    expect(computeAgeFactor(AGE_SATURATION_DAYS)).toBe(1)
    expect(computeAgeFactor(AGE_SATURATION_DAYS * 2)).toBe(1) // clamped
  })
})

describe('computeRiskScore', () => {
  it('produces a normalized 0-100 score with the full factor breakdown', () => {
    // Blend is curated THIRD_PARTY_AUDITED with a 2024 inception → mature + audited.
    const samples = [
      sample(20, 5.0, 1_000_000),
      sample(15, 5.1, 1_050_000),
      sample(10, 4.9, 1_100_000),
      sample(5, 5.0, 1_150_000),
      sample(1, 5.05, 1_200_000),
    ]
    const result = computeRiskScore('Blend', samples, NOW)

    expect(result.protocolName).toBe('Blend')
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.insufficientHistory).toBe(false)
    expect(result.sampleCount).toBe(5)
    expect(result.auditStatus).toBe('THIRD_PARTY_AUDITED')
    expect(result.protocolAgeDays).toBeGreaterThan(0)
    // Stable APY + growing TVL + audited + mature → a high (low-risk) score.
    expect(result.score).toBeGreaterThan(70)
  })

  it('scores an audited, stable protocol higher than an unaudited, volatile one', () => {
    const stableAudited = [
      sample(20, 5.0, 1_000_000),
      sample(10, 5.0, 1_100_000),
      sample(1, 5.0, 1_200_000),
    ]
    const volatileUnaudited = [
      sample(20, 1.0, 1_200_000),
      sample(10, 9.0, 900_000),
      sample(1, 4.0, 700_000),
    ]
    const good = computeRiskScore('Blend', stableAudited, NOW)
    // 'UnknownProtocol' is not curated → UNAUDITED, age 0.
    const bad = computeRiskScore('UnknownProtocol', volatileUnaudited, NOW)
    expect(good.score).toBeGreaterThan(bad.score)
  })

  describe('insufficient-history policy', () => {
    it('flags a brand-new protocol with too few samples and scores it conservatively low', () => {
      const samples = [sample(2, 5.0), sample(1, 5.2)] // 2 < MIN_SAMPLES_FOR_HISTORY
      const result = computeRiskScore('Blend', samples, NOW)
      expect(result.insufficientHistory).toBe(true)
      expect(result.score).toBe(INSUFFICIENT_HISTORY_SCORE)
    })

    it('does not give a no-history protocol a misleadingly neutral score', () => {
      const result = computeRiskScore('Blend', [], NOW)
      expect(result.sampleCount).toBe(0)
      expect(result.insufficientHistory).toBe(true)
      expect(result.score).toBe(INSUFFICIENT_HISTORY_SCORE)
      // Even though Blend is audited + mature, the score is NOT pulled up by
      // audit/age alone when history is absent.
      expect(result.score).toBeLessThan(50)
    })

    it('requires at least MIN_SAMPLES_FOR_HISTORY in-window samples', () => {
      const justEnough = Array.from(
        { length: MIN_SAMPLES_FOR_HISTORY },
        (_, i) => sample(i + 1, 5.0)
      )
      const result = computeRiskScore('Blend', justEnough, NOW)
      expect(result.insufficientHistory).toBe(false)
    })
  })

  describe('data-gap policy', () => {
    it('treats out-of-window samples as absent, not as favorable data', () => {
      // Plenty of history overall, but a long collector gap means only 2 samples
      // fall inside the trailing window → treated as insufficient, NOT scored as
      // if the missing days were stable/neutral.
      const samples = [
        sample(200, 5.0), // ancient, outside window
        sample(180, 5.0), // ancient, outside window
        sample(150, 5.0), // ancient, outside window
        sample(2, 5.0), // in window
        sample(1, 5.0), // in window
      ]
      const result = computeRiskScore('Blend', samples, NOW)
      expect(result.sampleCount).toBe(2)
      expect(result.insufficientHistory).toBe(true)
      expect(result.score).toBe(INSUFFICIENT_HISTORY_SCORE)
    })

    it('ignores null-TVL samples when computing the TVL trend rather than treating them as zero', () => {
      const withGaps = [
        sample(20, 5.0, 1_000_000),
        sample(15, 5.0, null), // gap in TVL data
        sample(10, 5.0, null), // gap in TVL data
        sample(5, 5.0, 1_100_000),
        sample(1, 5.0, 1_200_000),
      ]
      const result = computeRiskScore('Blend', withGaps, NOW)
      // Trend computed from the 3 real TVL points (all growing) → > 0.5, and
      // never dragged to 0 by treating the nulls as zero TVL.
      expect(result.tvlTrendFactor).toBeGreaterThan(0.5)
    })
  })

  it('is deterministic for the same inputs', () => {
    const samples = [
      sample(10, 5.0, 1_000_000),
      sample(5, 5.1, 1_050_000),
      sample(1, 4.9, 1_100_000),
    ]
    const a = computeRiskScore('Blend', samples, NOW)
    const b = computeRiskScore('Blend', samples, NOW)
    expect(a).toEqual(b)
  })
})
