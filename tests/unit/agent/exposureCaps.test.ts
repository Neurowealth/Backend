import {
  defaultCapForRiskTolerance,
  resolveProtocolCap,
  resolveExposureCap,
  availableFractionHeadroom,
  clampMoveToCap,
  sumCaps,
  buildExposureSnapshot,
  validateExposureCapConfig,
  planCappedRebalance,
  ExposureSnapshot,
} from '../../../src/agent/exposureCaps'

describe('exposureCaps', () => {
  describe('defaultCapForRiskTolerance', () => {
    it('returns configured fractions for known tolerances', () => {
      expect(defaultCapForRiskTolerance(1)).toBeCloseTo(0.25)
      expect(defaultCapForRiskTolerance(5)).toBeCloseTo(0.5)
      expect(defaultCapForRiskTolerance(10)).toBeCloseTo(1.0)
    })

    it('clamps out-of-range tolerances', () => {
      expect(defaultCapForRiskTolerance(0)).toBeCloseTo(0.25)
      expect(defaultCapForRiskTolerance(99)).toBeCloseTo(1.0)
      expect(
        defaultCapForRiskTolerance(undefined as unknown as number)
      ).toBeCloseTo(0.5)
    })
  })

  describe('resolveProtocolCap', () => {
    it('uses the risk-tolerance default when no override or default set', () => {
      const cap = resolveProtocolCap('Blend', 5)
      expect(cap).toMatchObject({
        protocol: 'Blend',
        maxFraction: 0.5,
        source: 'tolerance',
      })
    })

    it('defaultMaxFraction wins over the tolerance table', () => {
      const cap = resolveProtocolCap('Blend', 5, { defaultMaxFraction: 0.8 })
      expect(cap).toMatchObject({ maxFraction: 0.8, source: 'default' })
    })

    it('per-protocol override wins over default and tolerance', () => {
      const cap = resolveProtocolCap('Blend', 5, {
        defaultMaxFraction: 0.8,
        perProtocol: { Blend: { maxFraction: 0.3, maxAbsolute: '1000' } },
      })
      expect(cap).toMatchObject({
        maxFraction: 0.3,
        maxAbsolute: '1000',
        source: 'override',
        hasAbsolute: true,
      })
    })

    it('clamps an over-1 override fraction', () => {
      const cap = resolveProtocolCap('Blend', 5, {
        perProtocol: { Blend: { maxFraction: 2 } },
      })
      expect(cap.maxFraction).toBe(1)
    })
  })

  describe('buildExposureSnapshot', () => {
    it('computes fractions summing to 1', () => {
      const snap = buildExposureSnapshot({ Blend: 30, Luma: 70 })
      expect(snap.fractions.Blend).toBeCloseTo(0.3)
      expect(snap.fractions.Luma).toBeCloseTo(0.7)
      expect(snap.totalValue).toBe('100')
    })

    it('yields zero fractions for a zero-valued portfolio', () => {
      const snap = buildExposureSnapshot({ Blend: 0, Luma: 0 })
      expect(snap.fractions.Blend).toBe(0)
      expect(snap.fractions.Luma).toBe(0)
    })
  })

  describe('clampMoveToCap', () => {
    const snapshot: ExposureSnapshot = { fractions: { Blend: 0, Luma: 0.4 } }

    it('does not clamp when plenty of headroom remains', () => {
      const cap = resolveProtocolCap('Luma', 5, {
        perProtocol: { Luma: { maxFraction: 0.6 } },
      })
      const result = clampMoveToCap('Luma', 0.1, snapshot, cap)
      expect(result.clampedMove).toBeCloseTo(0.1)
      expect(result.postMoveFraction).toBeCloseTo(0.5)
      expect(result.boundedBy).toBe('none')
    })

    it('clamps to the cap when the move would exceed it', () => {
      const cap = resolveProtocolCap('Luma', 5, {
        perProtocol: { Luma: { maxFraction: 0.5 } },
      })
      // current 0.4, move 0.3 would post-move to 0.7 > 0.5 allowed 0.5
      const result = clampMoveToCap('Luma', 0.3, snapshot, cap)
      expect(result.clampedMove).toBeCloseTo(0.1)
      expect(result.postMoveFraction).toBeCloseTo(0.5)
      expect(result.boundedBy).toBe('fraction')
    })

    it('returns 0 clamped move when already at/over cap', () => {
      const snapshot2: ExposureSnapshot = { fractions: { Blend: 0, Luma: 0.6 } }
      const cap = resolveProtocolCap('Luma', 5, {
        perProtocol: { Luma: { maxFraction: 0.5 } },
      })
      const result = clampMoveToCap('Luma', 0.2, snapshot2, cap)
      expect(result.clampedMove).toBe(0)
      expect(result.postMoveFraction).toBeCloseTo(0.6)
    })

    it('bounds by absolute cap when maxAbsolute is the stricter limit', () => {
      // total value 100, absolute cap 45 → effective fraction 0.45 < 0.6.
      const snap: ExposureSnapshot = {
        fractions: { Luma: 0.4 },
        totalValue: '100',
      }
      const cap = resolveProtocolCap('Luma', 5, {
        perProtocol: { Luma: { maxFraction: 0.6, maxAbsolute: '45' } },
      })
      const result = clampMoveToCap('Luma', 0.3, snap, cap, 100)
      expect(result.clampedMove).toBeCloseTo(0.05)
      expect(result.postMoveFraction).toBeLessThanOrEqual(0.45 + 1e-9)
      expect(result.boundedBy).toBe('absolute')
    })
  })

  describe('availableFractionHeadroom', () => {
    it('is zero for a protocol at its cap', () => {
      const snapshot: ExposureSnapshot = { fractions: { Blend: 0, Luma: 0.5 } }
      const cap = resolveProtocolCap('Luma', 5, {
        perProtocol: { Luma: { maxFraction: 0.5 } },
      })
      expect(availableFractionHeadroom('Luma', snapshot, cap)).toBe(0)
    })
  })

  describe('sumCaps / unplaceable detection', () => {
    it('sums the caps of the eligible set', () => {
      const caps = resolveExposureCap(['Blend', 'Luma'], 1) // 0.25 each
      const result = sumCaps(['Blend', 'Luma'], { fractions: {} }, caps)
      expect(result).toBeCloseTo(0.5)
    })

    it('caps at 1.0 so sumCaps never exceeds a full portfolio', () => {
      const caps = resolveExposureCap(['Blend', 'Luma'], 10) // 1.0 each
      const result = sumCaps(['Blend', 'Luma'], { fractions: {} }, caps)
      expect(result).toBe(1)
    })
  })

  describe('resolveExposureCap map', () => {
    it('resolves all protocols deterministically', () => {
      const caps = resolveExposureCap(['Blend', 'Luma', 'Stellar DEX'], 3)
      expect(Object.keys(caps)).toEqual(['Blend', 'Luma', 'Stellar DEX'])
      expect(caps.Blend.maxFraction).toBeCloseTo(0.35)
    })
  })

  describe('planCappedRebalance', () => {
    const caps = resolveExposureCap(['Blend', 'Luma', 'Stellar DEX'], 2)

    it('allocates fully to the single preferred target when no cap binds', () => {
      const capsNoBind = resolveExposureCap(['Luma'], 10) // cap 1.0 → never binds
      const snapshot: ExposureSnapshot = { fractions: { Blend: 0, Luma: 0 } }
      const plan = planCappedRebalance(['Luma'], 1, snapshot, capsNoBind)
      expect(plan.allocations[0].fraction).toBeCloseTo(1)
      expect(plan.unplacedFraction).toBeCloseTo(0)
    })

    it('clamps the preferred target to its cap and routes residual to the next best', () => {
      // Luma current fraction 0.2, cap 0.3 → headroom 0.1. Blend cap 0.3.
      const snapshot: ExposureSnapshot = { fractions: { Luma: 0.2, Blend: 0 } }
      const plan = planCappedRebalance(['Luma', 'Blend'], 1, snapshot, caps)
      const luma = plan.allocations.find((a) => a.protocol === 'Luma')!
      const blend = plan.allocations.find((a) => a.protocol === 'Blend')!
      expect(luma.fraction).toBeCloseTo(0.1)
      expect(luma.capped).toBe(true)
      expect(blend.fraction).toBeCloseTo(0.3)
      // Total placed = 0.4; the rest is unplaced (portfolio not placeable).
      expect(plan.unplacedFraction).toBeCloseTo(0.6)
    })

    it('flags an already over-cap held protocol', () => {
      const snapshot: ExposureSnapshot = { fractions: { Luma: 0.9, Blend: 0 } }
      const plan = planCappedRebalance(['Blend'], 1, snapshot, caps)
      expect(plan.overCapProtocols).toContain('Luma')
    })

    it('never places more than the cap even when a single protocol is preferred', () => {
      const snapshot: ExposureSnapshot = { fractions: { Luma: 0 } }
      const plan = planCappedRebalance(['Luma'], 1, snapshot, {
        Luma: resolveProtocolCap('Luma', 1, { defaultMaxFraction: 0.25 }),
      })
      expect(plan.allocations[0].fraction).toBeCloseTo(0.25)
      expect(plan.unplacedFraction).toBeCloseTo(0.75)
    })
  })

  describe('validateExposureCapConfig', () => {
    it('accepts a valid config', () => {
      const issues = validateExposureCapConfig({
        defaultMaxFraction: 0.5,
        perProtocol: { Blend: { maxFraction: 0.3, maxAbsolute: '5000' } },
      })
      expect(issues).toEqual([])
    })

    it('rejects a maxFraction outside (0, 1]', () => {
      const issues = validateExposureCapConfig({
        perProtocol: { Blend: { maxFraction: 0 } },
      })
      expect(issues.length).toBeGreaterThan(0)
    })

    it('rejects an unknown key', () => {
      const issues = validateExposureCapConfig({
        perProtocol: { Blend: { maxFraction: 0.3, bogus: 1 } },
      })
      expect(issues.length).toBeGreaterThan(0)
    })

    it('rejects an out-of-range defaultMaxFraction', () => {
      const issues = validateExposureCapConfig({ defaultMaxFraction: 1.5 })
      expect(issues.length).toBeGreaterThan(0)
    })

    it('rejects a non-object root', () => {
      expect(validateExposureCapConfig('nope').length).toBeGreaterThan(0)
    })
  })
})
