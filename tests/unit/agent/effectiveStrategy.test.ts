/**
 * #285 — own-vs-followed config resolution.
 *
 * This module decides what the agent does with someone's money when they follow
 * a stranger's configuration, so the risk-ceiling invariant ("a follow may only
 * tighten, never widen") and the no-follow identity are the load-bearing cases.
 */
import {
  isKnownStrategyName,
  isMaterialConfigChange,
  normalizeStrategyConfig,
  parseStrategyConfig,
  resolveEffectiveConfig,
  stricterRiskCeiling,
} from '../../../src/agent/effectiveStrategy'

describe('isKnownStrategyName', () => {
  it('accepts the three strategies the router can dispatch', () => {
    expect(isKnownStrategyName('MAX_YIELD')).toBe(true)
    expect(isKnownStrategyName('TARGET_ALLOCATION')).toBe(true)
    expect(isKnownStrategyName('GOAL_TRACKING')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isKnownStrategyName('SUPER_YIELD')).toBe(false)
    expect(isKnownStrategyName(null)).toBe(false)
    expect(isKnownStrategyName(42)).toBe(false)
  })
})

describe('parseStrategyConfig', () => {
  it('keeps only the three agent-relevant keys', () => {
    expect(
      parseStrategyConfig({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 60, Luma: 40 },
        riskCeiling: 70,
        riskTolerance: 9,
        walletAddress: 'GABC',
      })
    ).toEqual({
      strategyName: 'TARGET_ALLOCATION',
      targetAllocations: { Blend: 60, Luma: 40 },
      riskCeiling: 70,
    })
  })

  it('drops an unknown strategy name rather than passing it to a lookup', () => {
    expect(parseStrategyConfig({ strategyName: 'MOON_MODE' })).toEqual({})
  })

  it('drops non-numeric allocation weights and an empty allocation map', () => {
    expect(
      parseStrategyConfig({
        strategyName: 'MAX_YIELD',
        targetAllocations: { Blend: 'lots' as unknown as number },
      })
    ).toEqual({ strategyName: 'MAX_YIELD' })
  })

  it('returns an empty config for null, arrays, and primitives', () => {
    expect(parseStrategyConfig(null)).toEqual({})
    expect(parseStrategyConfig([1, 2])).toEqual({})
    expect(parseStrategyConfig('MAX_YIELD')).toEqual({})
    expect(parseStrategyConfig(undefined)).toEqual({})
  })

  it('drops a non-finite risk ceiling', () => {
    expect(
      parseStrategyConfig({ strategyName: 'MAX_YIELD', riskCeiling: NaN })
    ).toEqual({ strategyName: 'MAX_YIELD' })
  })
})

describe('stricterRiskCeiling', () => {
  it('picks the higher value, since higher score = lower risk', () => {
    expect(stricterRiskCeiling(60, 80)).toBe(80)
    expect(stricterRiskCeiling(80, 60)).toBe(80)
  })

  it('treats absent as "no ceiling" and therefore the loosest', () => {
    expect(stricterRiskCeiling(undefined, 70)).toBe(70)
    expect(stricterRiskCeiling(70, undefined)).toBe(70)
    expect(stricterRiskCeiling(undefined, undefined)).toBeUndefined()
  })
})

describe('resolveEffectiveConfig — no follow', () => {
  it('returns the caller‘s own config unchanged', () => {
    const own = {
      strategyName: 'TARGET_ALLOCATION' as const,
      targetAllocations: { Blend: 100 },
      riskCeiling: 55,
    }
    expect(resolveEffectiveConfig(own)).toEqual(own)
    expect(resolveEffectiveConfig(own, null)).toEqual(own)
    expect(resolveEffectiveConfig(own, undefined)).toEqual(own)
  })

  it('normalizes an absent strategy to null without inventing one', () => {
    expect(resolveEffectiveConfig({})).toEqual({
      strategyName: null,
      targetAllocations: undefined,
      riskCeiling: undefined,
    })
  })
})

describe('resolveEffectiveConfig — with a follow', () => {
  it('lets the followed strategy and its allocations win', () => {
    const result = resolveEffectiveConfig(
      { strategyName: 'MAX_YIELD' },
      {
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 70, Luma: 30 },
      }
    )
    expect(result.strategyName).toBe('TARGET_ALLOCATION')
    expect(result.targetAllocations).toEqual({ Blend: 70, Luma: 30 })
  })

  it('does not pair the followed strategy with the follower‘s leftover allocations', () => {
    // Mixing the two would produce a configuration neither party chose.
    const result = resolveEffectiveConfig(
      {
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 100 },
      },
      { strategyName: 'MAX_YIELD' }
    )
    expect(result.strategyName).toBe('MAX_YIELD')
    expect(result.targetAllocations).toBeUndefined()
  })

  it('falls back to the follower‘s own strategy when the snapshot has none', () => {
    const result = resolveEffectiveConfig(
      { strategyName: 'MAX_YIELD', targetAllocations: { Blend: 100 } },
      { riskCeiling: 80 }
    )
    expect(result.strategyName).toBe('MAX_YIELD')
    expect(result.targetAllocations).toEqual({ Blend: 100 })
    expect(result.riskCeiling).toBe(80)
  })

  it('adopts the followed strategy when the follower has none of their own', () => {
    // The common case for a new user — exactly who this feature targets.
    const result = resolveEffectiveConfig(
      {},
      { strategyName: 'MAX_YIELD', riskCeiling: 65 }
    )
    expect(result.strategyName).toBe('MAX_YIELD')
    expect(result.riskCeiling).toBe(65)
  })
})

describe('resolveEffectiveConfig — the risk-ceiling invariant', () => {
  it('tightens when the publisher is stricter', () => {
    const result = resolveEffectiveConfig(
      { strategyName: 'MAX_YIELD', riskCeiling: 50 },
      { strategyName: 'MAX_YIELD', riskCeiling: 85 }
    )
    expect(result.riskCeiling).toBe(85)
  })

  it('NEVER widens when the publisher is looser', () => {
    const result = resolveEffectiveConfig(
      { strategyName: 'MAX_YIELD', riskCeiling: 85 },
      { strategyName: 'MAX_YIELD', riskCeiling: 50 }
    )
    expect(result.riskCeiling).toBe(85)
  })

  it('applies the publisher‘s ceiling to a follower who had none', () => {
    const result = resolveEffectiveConfig(
      { strategyName: 'MAX_YIELD' },
      { strategyName: 'MAX_YIELD', riskCeiling: 70 }
    )
    expect(result.riskCeiling).toBe(70)
  })

  it('keeps the follower‘s ceiling when the publisher set none', () => {
    const result = resolveEffectiveConfig(
      { strategyName: 'MAX_YIELD', riskCeiling: 70 },
      { strategyName: 'TARGET_ALLOCATION', targetAllocations: { Blend: 100 } }
    )
    expect(result.riskCeiling).toBe(70)
  })
})

describe('material change detection', () => {
  it('ignores allocation key ordering', () => {
    expect(
      normalizeStrategyConfig({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Luma: 40, Blend: 60 },
      })
    ).toBe(
      normalizeStrategyConfig({
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 60, Luma: 40 },
      })
    )
  })

  it('is false for an identical config (a label-only edit must not notify)', () => {
    const config = {
      strategyName: 'TARGET_ALLOCATION' as const,
      targetAllocations: { Blend: 60, Luma: 40 },
      riskCeiling: 70,
    }
    expect(isMaterialConfigChange(config, { ...config })).toBe(false)
  })

  it('is true when the strategy, an allocation weight, or the ceiling changes', () => {
    const base = {
      strategyName: 'TARGET_ALLOCATION' as const,
      targetAllocations: { Blend: 60, Luma: 40 },
      riskCeiling: 70,
    }
    expect(
      isMaterialConfigChange(base, { ...base, strategyName: 'MAX_YIELD' })
    ).toBe(true)
    expect(
      isMaterialConfigChange(base, {
        ...base,
        targetAllocations: { Blend: 50, Luma: 50 },
      })
    ).toBe(true)
    expect(isMaterialConfigChange(base, { ...base, riskCeiling: 80 })).toBe(
      true
    )
  })

  it('treats adding or removing a ceiling as material', () => {
    expect(
      isMaterialConfigChange(
        { strategyName: 'MAX_YIELD' },
        { strategyName: 'MAX_YIELD', riskCeiling: 60 }
      )
    ).toBe(true)
  })
})
