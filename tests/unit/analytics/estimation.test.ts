/**
 * Estimation layer unit tests (#322).
 *
 * The headline correctness property here is INDEX ALIGNMENT: covariance entry
 * (i,j) must pair protocol i and protocol j on the SAME day. A misaligned matrix
 * looks perfectly well-formed and is silently wrong, so several tests below
 * exercise gappy and ragged inputs specifically.
 */

import {
  DEFAULT_LOOKBACK_DAYS,
  MIN_ALIGNED_OBSERVATIONS,
  aggregateDailyRates,
  estimate,
  sampleCovariance,
} from '../../../src/analytics/estimation'
import { RawRateObservation, RiskScoreRow } from '../../../src/analytics/types'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-17T00:00:00Z')

function series(
  protocolName: string,
  days: number,
  apyAt: (d: number) => number,
  opts: { skip?: (d: number) => boolean } = {}
): RawRateObservation[] {
  const out: RawRateObservation[] = []
  for (let d = 0; d < days; d++) {
    if (opts.skip?.(d)) continue
    out.push({
      protocolName,
      assetSymbol: 'USDC',
      apy: apyAt(d),
      date: new Date(NOW.getTime() - (days - 1 - d) * DAY),
    })
  }
  return out
}

const scores = (...rows: Array<[string, number, boolean?]>): RiskScoreRow[] =>
  rows.map(([protocolName, score, insufficientHistory]) => ({
    protocolName,
    score,
    insufficientHistory: insufficientHistory ?? false,
  }))

describe('aggregateDailyRates', () => {
  it('averages multiple assets and multiple scans on the same day', () => {
    const at = new Date('2026-08-10T00:00:00Z')
    const out = aggregateDailyRates([
      { protocolName: 'Blend', assetSymbol: 'USDC', apy: 10, date: at },
      {
        protocolName: 'Blend',
        assetSymbol: 'XLM',
        apy: 14,
        date: new Date(at.getTime() + 3600_000),
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].apy).toBeCloseTo(12, 10)
  })

  it('preserves protocol names containing spaces', () => {
    // Regression: an earlier draft rebuilt the name by splitting the map key on
    // a space, which truncated "Stellar DEX" into a different protocol.
    const out = aggregateDailyRates([
      {
        protocolName: 'Stellar DEX',
        assetSymbol: 'USDC',
        apy: 5,
        date: NOW,
      },
    ])
    expect(out[0].protocolName).toBe('Stellar DEX')
  })

  it('ignores non-finite APYs rather than poisoning the average', () => {
    const out = aggregateDailyRates([
      { protocolName: 'A', assetSymbol: 'USDC', apy: NaN, date: NOW },
      { protocolName: 'A', assetSymbol: 'XLM', apy: 8, date: NOW },
    ])
    expect(out[0].apy).toBe(8)
  })

  it('is deterministic regardless of input order', () => {
    const rows = series('A', 5, (d) => 5 + d)
    const forward = JSON.stringify(aggregateDailyRates(rows))
    const reversed = JSON.stringify(aggregateDailyRates([...rows].reverse()))
    expect(forward).toBe(reversed)
  })
})

describe('sampleCovariance', () => {
  it('uses the n-1 convention, matching sampleStdev', () => {
    // var([1,2,3,4]) with n-1 = 5/3
    const cov = sampleCovariance([[1, 2, 3, 4]])
    expect(cov[0][0]).toBeCloseTo(5 / 3, 12)
  })

  it('is exactly symmetric, not merely symmetric to within epsilon', () => {
    const cov = sampleCovariance([
      [1, 2, 3, 4, 5],
      [2, 1, 4, 3, 6],
      [5, 3, 2, 4, 1],
    ])
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(cov[i][j]).toBe(cov[j][i])
      }
    }
  })

  it('is positive semi-definite', () => {
    const cov = sampleCovariance([
      [1, 2, 3, 4, 5, 4, 3],
      [2, 1, 4, 3, 6, 2, 5],
      [5, 3, 2, 4, 1, 3, 2],
    ])
    for (let s = 1; s <= 300; s++) {
      const v = [Math.sin(s), Math.cos(s * 1.7), Math.sin(s * 2.3)]
      let q = 0
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) q += v[i] * cov[i][j] * v[j]
      }
      expect(q).toBeGreaterThanOrEqual(-1e-12)
    }
  })

  it('returns zeros for a single observation (no n-1 divide by zero)', () => {
    expect(sampleCovariance([[5], [7]])).toEqual([
      [0, 0],
      [0, 0],
    ])
  })
})

describe('estimate — universe eligibility', () => {
  const rates = [
    ...series('Good', 90, () => 8),
    ...series('Thin', 90, () => 12),
    ...series('Risky', 90, () => 15),
  ]

  it('excludes protocols flagged insufficientHistory, with a reason', () => {
    const r = estimate({
      rates,
      riskScores: scores(['Good', 80], ['Thin', 20, true], ['Risky', 60]),
      now: NOW,
    })
    expect(r.protocols).toEqual(['Good', 'Risky'])
    expect(r.excluded).toContainEqual(
      expect.objectContaining({
        protocol: 'Thin',
        reason: 'insufficient_history',
      })
    )
  })

  it('excludes protocols with no risk-score row at all (fail-closed)', () => {
    const r = estimate({
      rates,
      riskScores: scores(['Good', 80], ['Risky', 60]),
      now: NOW,
    })
    expect(r.protocols).not.toContain('Thin')
    expect(r.excluded).toContainEqual(
      expect.objectContaining({ protocol: 'Thin', reason: 'no_risk_score' })
    )
  })

  it('applies the risk ceiling and records the failing score', () => {
    const r = estimate({
      rates,
      riskScores: scores(['Good', 80], ['Thin', 40], ['Risky', 60]),
      riskCeiling: 70,
      now: NOW,
    })
    expect(r.protocols).toEqual(['Good'])
    const risky = r.excluded.find((e) => e.protocol === 'Risky')
    expect(risky?.reason).toBe('risk_ceiling')
    expect(risky?.detail).toContain('60')
    expect(risky?.detail).toContain('70')
  })

  it('excludes a scored protocol with no rate history in the window', () => {
    const r = estimate({
      rates: series('Good', 90, () => 8),
      riskScores: scores(['Good', 80], ['Ghost', 90]),
      now: NOW,
    })
    expect(r.excluded).toContainEqual(
      expect.objectContaining({ protocol: 'Ghost', reason: 'no_rate_history' })
    )
    expect(r.riskScores.Ghost).toBeUndefined()
  })
})

describe('estimate — statistics', () => {
  it('expected return is the mean annual rate as a decimal fraction', () => {
    // Constant 8% APY -> mu = 0.08 exactly.
    const r = estimate({
      rates: [...series('A', 60, () => 8), ...series('B', 60, () => 4)],
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    expect(r.protocols).toEqual(['A', 'B'])
    expect(r.expectedReturns[0]).toBeCloseTo(0.08, 12)
    expect(r.expectedReturns[1]).toBeCloseTo(0.04, 12)
  })

  it('a flat series has zero variance', () => {
    const r = estimate({
      rates: [...series('A', 60, () => 8), ...series('B', 60, () => 4)],
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    expect(r.covariance[0][0]).toBeCloseTo(0, 15)
  })

  it('perfectly co-moving protocols have correlation 1', () => {
    const r = estimate({
      rates: [
        ...series('A', 60, (d) => 8 + (d % 5)),
        ...series('B', 60, (d) => 12 + (d % 5)),
      ],
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    const corr =
      r.covariance[0][1] / Math.sqrt(r.covariance[0][0] * r.covariance[1][1])
    expect(corr).toBeCloseTo(1, 9)
  })

  it('anti-correlated protocols have correlation -1', () => {
    const r = estimate({
      rates: [
        ...series('A', 60, (d) => 8 + (d % 5)),
        ...series('B', 60, (d) => 12 - (d % 5)),
      ],
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    const corr =
      r.covariance[0][1] / Math.sqrt(r.covariance[0][0] * r.covariance[1][1])
    expect(corr).toBeCloseTo(-1, 9)
  })
})

describe('estimate — alignment', () => {
  it('forward-fills gaps so a gappy protocol stays index-aligned', () => {
    // B is missing every third day; forward-fill keeps the grid complete.
    const r = estimate({
      rates: [
        ...series('A', 60, (d) => 8 + (d % 4)),
        ...series('B', 60, (d) => 5 + (d % 3), { skip: (d) => d % 3 === 1 }),
      ],
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    expect(r.protocols).toEqual(['A', 'B'])
    expect(r.observationCount).toBe(60)
    expect(r.covariance).toHaveLength(2)
  })

  it('only counts days on which EVERY protocol has a value', () => {
    // B's first observation is 20 days after A's, so the first 40 days of the
    // window have no B value to hold forward and cannot be aligned.
    const rates = [...series('A', 60, () => 8), ...series('B', 20, () => 5)]
    const r = estimate({
      rates,
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    expect(r.observationCount).toBe(20)
  })

  it('drops the whole universe below the aligned-observation minimum', () => {
    const shortDays = MIN_ALIGNED_OBSERVATIONS - 1
    const r = estimate({
      rates: [
        ...series('A', shortDays, () => 8),
        ...series('B', shortDays, () => 5),
      ],
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    expect(r.protocols).toEqual([])
    expect(r.observationCount).toBe(0)
    expect(
      r.excluded.filter((e) => e.reason === 'insufficient_aligned_history')
    ).toHaveLength(2)
  })

  it('honours a custom lookback window', () => {
    const r = estimate({
      rates: [...series('A', 90, () => 8), ...series('B', 90, () => 5)],
      riskScores: scores(['A', 80], ['B', 80]),
      lookbackDays: 30,
      now: NOW,
    })
    expect(r.lookbackDays).toBe(30)
    expect(r.observationCount).toBe(30)
  })

  it('defaults the lookback to DEFAULT_LOOKBACK_DAYS', () => {
    const r = estimate({
      rates: [...series('A', 200, () => 8), ...series('B', 200, () => 5)],
      riskScores: scores(['A', 80], ['B', 80]),
      now: NOW,
    })
    expect(r.lookbackDays).toBe(DEFAULT_LOOKBACK_DAYS)
    expect(r.observationCount).toBe(DEFAULT_LOOKBACK_DAYS)
  })
})

describe('estimate — determinism', () => {
  it('is invariant to input ordering', () => {
    const rates = [
      ...series('Zeta', 60, (d) => 8 + (d % 7)),
      ...series('Alpha', 60, (d) => 5 + (d % 3)),
    ]
    const riskScores = scores(['Zeta', 80], ['Alpha', 70])

    const a = estimate({ rates, riskScores, now: NOW })
    const b = estimate({
      rates: [...rates].reverse(),
      riskScores: [...riskScores].reverse(),
      now: NOW,
    })
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('returns protocols sorted by name', () => {
    const r = estimate({
      rates: [
        ...series('Zeta', 60, () => 8),
        ...series('Alpha', 60, () => 5),
        ...series('Mid', 60, () => 6),
      ],
      riskScores: scores(['Zeta', 80], ['Alpha', 70], ['Mid', 75]),
      now: NOW,
    })
    expect(r.protocols).toEqual(['Alpha', 'Mid', 'Zeta'])
  })
})
