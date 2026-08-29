/**
 * Correlation matrix + diversification score unit tests (#348).
 *
 * The headline properties: correlation is symmetric, diagonal-1, bounded in
 * [-1,1], and null-on-degenerate (a constant series has no defined correlation —
 * we never claim 0). The diversification score is 0-100 and null when there is
 * nothing computable.
 */

import {
  computeCorrelationMatrix,
  averagePairwiseCorrelation,
  diversificationScore,
  estimateCorrelation,
  CORRELATION_CAVEAT,
} from '../../../src/analytics/correlation'
import { RawRateObservation } from '../../../src/analytics/types'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-17T00:00:00Z')

function series(
  protocolName: string,
  days: number,
  apyAt: (d: number) => number
): RawRateObservation[] {
  const out: RawRateObservation[] = []
  for (let d = 0; d < days; d++) {
    out.push({
      protocolName,
      assetSymbol: 'USDC',
      apy: apyAt(d),
      date: new Date(NOW.getTime() - (days - 1 - d) * DAY),
    })
  }
  return out
}

describe('computeCorrelationMatrix', () => {
  it('is symmetric with a diagonal of 1', () => {
    const cols = [series('A', 20, (d) => 5 + d), series('B', 20, (d) => 7 - d)]
    const [a, b] = cols.map((c) => c.map((r) => r.apy / 100))
    const m = computeCorrelationMatrix([a, b])
    expect(m[0][0]).toBe(1)
    expect(m[1][1]).toBe(1)
    expect(m[0][1]).toBeCloseTo(m[1][0]!, 12)
  })

  it('approaches +1 for perfectly synchronised series', () => {
    // B is an exact positive multiple+offset of A → perfect correlation.
    const a = series('A', 30, (d) => 5 + 0.5 * d).map((r) => r.apy)
    const b = series('B', 30, (d) => 3 + 1.0 * d).map((r) => r.apy)
    const m = computeCorrelationMatrix([a, b])
    expect(m[0][1]!).toBeGreaterThan(0.9999)
  })

  it('approaches -1 for perfectly inverse series', () => {
    const a = series('A', 30, (d) => 5 + d).map((r) => r.apy)
    const b = series('B', 30, (d) => 5 - d).map((r) => r.apy)
    const m = computeCorrelationMatrix([a, b])
    expect(m[0][1]!).toBeLessThan(-0.9999)
  })

  it('is null (not 0) when a series is degenerate/constant', () => {
    const a = series('A', 30, () => 8).map((r) => r.apy) // constant → 0 variance
    const b = series('B', 30, (d) => 5 + d).map((r) => r.apy)
    const m = computeCorrelationMatrix([a, b])
    expect(m[0][1]).toBeNull()
  })
})

describe('averagePairwiseCorrelation / diversificationScore', () => {
  const names = ['A', 'B']
  const corrHigh = [
    [1, 0.9],
    [0.9, 1],
  ]
  const corrLow = [
    [1, 0.1],
    [0.1, 1],
  ]

  it('computes the average of the off-diagonal', () => {
    expect(averagePairwiseCorrelation(names, corrHigh)).toBeCloseTo(0.9, 12)
  })

  it('computes a 0-100 diversification score (higher = more diversified)', () => {
    // avg 0.9 → score 10; avg 0.1 → score 90.
    expect(diversificationScore(names, corrHigh)).toBeCloseTo(10, 12)
    expect(diversificationScore(names, corrLow)).toBeCloseTo(90, 12)
  })

  it('weights the score by portfolio weight when supplied', () => {
    // B nearly unheld → its correlation barely counts. weight A=0.99, B=0.01.
    const weighted = averagePairwiseCorrelation(names, corrHigh, {
      A: 0.99,
      B: 0.01,
    })
    // still just one pair, so the score is unchanged (single off-diagonal pair)
    expect(weighted).toBeCloseTo(0.9, 12)
    // But with a 3-way matrix, weights change which pairs dominate.
    const names3 = ['A', 'B', 'C']
    const corr3 = [
      [1, 0.9, 0.9],
      [0.9, 1, 0.0],
      [0.9, 0.0, 1],
    ]
    const equal = averagePairwiseCorrelation(names3, corr3)!
    const weighted3 = averagePairwiseCorrelation(names3, corr3, {
      A: 0.98,
      B: 0.01,
      C: 0.01,
    })!
    expect(weighted3).toBeGreaterThan(equal)
  })

  it('is null when there are fewer than 2 protocols', () => {
    expect(diversificationScore(['A'], [[1]], {})).toBeNull()
  })
})

describe('estimateCorrelation', () => {
  it('computes a non-null score over ≥14 aligned days of correlated yield', () => {
    const rates = [
      ...series('Blend', 60, (d) => 5 + 0.3 * d),
      ...series('Luma', 60, (d) => 4 + 0.3 * d),
    ]
    const result = estimateCorrelation({ rates, now: NOW })
    expect(result.protocols).toEqual(['Blend', 'Luma'])
    expect(result.observationCount).toBeGreaterThanOrEqual(14)
    expect(result.averageCorrelation).not.toBeNull()
    // Positively correlated yield → high corr → LOW diversification score.
    expect(result.averageCorrelation!).toBeGreaterThan(0.9)
    expect(result.diversificationScore!).toBeLessThan(10)
    expect(result.caveat).toBe(CORRELATION_CAVEAT)
  })

  it('reports a max diversification score for inverse (strongly decoupled) yield', () => {
    // These two sequences move in opposite directions → negative average
    // correlation → diversification score clamps to the 0-100 ceiling (100).
    const seqA = [1, 2, 6, 3, 8, 2, 9, 1, 5, 7, 4, 6, 2, 8, 3, 5, 9, 1, 4, 7]
    const seqB = [9, 7, 2, 8, 1, 9, 2, 6, 4, 1, 7, 3, 8, 2, 6, 4, 1, 8, 7, 3]
    const rates = [
      ...seqA.map((v, i) => ({
        protocolName: 'Alpha',
        assetSymbol: 'USDC',
        apy: v,
        date: new Date(NOW.getTime() - (seqA.length - 1 - i) * DAY),
      })),
      ...seqB.map((v, i) => ({
        protocolName: 'Beta',
        assetSymbol: 'USDC',
        apy: v,
        date: new Date(NOW.getTime() - (seqB.length - 1 - i) * DAY),
      })),
    ]
    const result = estimateCorrelation({ rates, now: NOW })
    expect(result.protocols).toEqual(['Alpha', 'Beta'])
    expect(result.averageCorrelation!).toBeLessThan(-0.9)
    // Negative correlation must clamp to 100, never exceed the 0-100 range.
    expect(result.diversificationScore!).toBe(100)
  })

  it('returns empty (computed:false upstream) when <2 admitted', () => {
    const result = estimateCorrelation({
      rates: series('Blend', 30, (d) => 5 + d),
      now: NOW,
    })
    expect(result.protocols).toHaveLength(0)
    expect(result.diversificationScore).toBeNull()
    expect(result.averageCorrelation).toBeNull()
  })

  it('hands the portfolio weights through to the score', () => {
    const rates = [
      ...series('Blend', 60, (d) => 5 + 0.3 * d),
      ...series('Luma', 60, (d) => 4 + 0.3 * d),
      ...series('Aqua', 60, (d) => 6 - 0.2 * d),
    ]
    const weighted = estimateCorrelation({
      rates,
      now: NOW,
      weights: { Blend: 0.9, Luma: 0.05, Aqua: 0.05 },
    })
    const equal = estimateCorrelation({ rates, now: NOW })
    expect(weighted.diversificationScore).not.toBeNull()
    expect(equal.diversificationScore).not.toBeNull()
  })
})
