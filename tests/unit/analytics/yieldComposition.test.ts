/**
 * Yield composition unit tests (#349).
 *
 * The headline property: incentive yield is valued at a HAIRCUT, not face value;
 * when no split exists the raw supply APY is used unchanged; and degenerate
 * (unknown) inputs yield null, never 0.
 */

import {
  effectiveApy,
  incentiveShare,
  shouldUseEffectiveApy,
  INCENTIVE_HAIRCUT,
  YIELD_CAVEAT,
} from '../../../src/analytics/yieldComposition'

describe('effectiveApy', () => {
  it('haircuts the incentive component when a split exists', () => {
    // base 3, incentive 5 → 3 + 5×(1−0.15) = 3 + 4.25 = 7.25
    expect(effectiveApy({ baseApy: 3, incentiveApy: 5 })).toBeCloseTo(
      3 + 5 * (1 - INCENTIVE_HAIRCUT),
      10
    )
  })

  it('falls back to raw supplyApy when there is no split', () => {
    expect(effectiveApy({ supplyApy: 8.4 })).toBeCloseTo(8.4, 10)
  })

  it('uses a single known part at face value', () => {
    expect(effectiveApy({ baseApy: 4 })).toBeCloseTo(4, 10)
    expect(effectiveApy({ incentiveApy: 2 })).toBeCloseTo(2, 10)
  })

  it('is null-on-degenerate (nothing known), never 0', () => {
    expect(effectiveApy({})).toBeNull()
    expect(
      effectiveApy({ baseApy: null, incentiveApy: null, supplyApy: null })
    ).toBeNull()
  })

  it('is never negative even if incentive exceeds base massively', () => {
    // incentive grows unboundedly → haircut keeps a positive effective yield.
    expect(effectiveApy({ baseApy: 0, incentiveApy: 1000 })).toBe(850)
  })
})

describe('incentiveShare', () => {
  it('computes the 0-1 share of yield from incentives', () => {
    expect(incentiveShare(3, 5)).toBeCloseTo(5 / 8, 10)
  })

  it('is null when the split is unknown', () => {
    expect(incentiveShare(null, null)).toBeNull()
    expect(incentiveShare(3, null)).toBeNull()
  })

  it('is null when total yield is non-positive', () => {
    expect(incentiveShare(0, 0)).toBeNull()
  })
})

describe('shouldUseEffectiveApy', () => {
  it('is off unless explicitly enabled', () => {
    expect(shouldUseEffectiveApy({})).toBe(false)
    expect(shouldUseEffectiveApy({ USE_EFFECTIVE_APY: 'false' })).toBe(false)
    expect(shouldUseEffectiveApy({ USE_EFFECTIVE_APY: 'true' })).toBe(true)
  })
})

describe('YIELD_CAVEAT', () => {
  it('warns that effective APY is not a guaranteed return', () => {
    expect(YIELD_CAVEAT).toContain('haircut')
    expect(YIELD_CAVEAT).not.toBe('')
  })
})
