import {
  estimateRebalanceCost,
  computePaybackDays,
  passesPaybackGate,
  annualizedBenefitPct,
  amountToHumanUnits,
  NETWORK_FEE_FALLBACK_USD,
} from '../../../src/agent/rebalanceCost'

const round = (n: number, d = 6) =>
  Math.round(n * Math.pow(10, d)) / Math.pow(10, d)

describe('rebalanceCost', () => {
  describe('amountToHumanUnits / /1e18 regression', () => {
    it('uses real asset decimals, not the hardcoded /1e18 wei assumption', () => {
      // 1_000_000 raw units of an 18-decimal token = 1e-something; the old code
      // would treat a 36,18 Decimal amount as wei and divide by 1e18.
      expect(amountToHumanUnits('1000000000000000000000', 18)).toBeCloseTo(1000)
      // USD-token with 6 decimals: 1_000_000 raw = 1.0 human unit.
      expect(amountToHumanUnits('1000000', 6)).toBeCloseTo(1)
    })

    it('returns 0 for non-positive/invalid amounts', () => {
      expect(amountToHumanUnits('0', 18)).toBe(0)
      expect(amountToHumanUnits('-5', 18)).toBe(0)
    })
  })

  describe('estimateRebalanceCost', () => {
    it('computes a measured cost from a live fee snapshot', () => {
      // 1000 USDC (6 decimals) move, live oracle at 100 stroops.
      const cost = estimateRebalanceCost({
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        amount: '1000000000',
        assetDecimals: 6,
        assetUsd: 1,
        sameAsset: true,
        priceImpactBps: 0,
        feeSnapshot: {
          recommendedBaseFee: 100,
          congestionLevel: 'low',
          fetchedAt: new Date(),
        },
        xlmUsd: 0.1,
      })
      // networkFeeXlm = 100 * 1e-7 = 1e-5 XLM; usd = 1e-5 * 0.1 = 1e-6 USD.
      // pct of 1000 USD = 1e-6/1000 * 100 = 1e-7.
      expect(cost.dataConfidence).toBe('measured')
      expect(round(cost.networkFeePctOfAmount, 9)).toBeCloseTo(1e-7, 9)
      expect(cost.priceImpactBps).toBe(0)
      expect(cost.totalCostPct).toBeGreaterThan(0)
    })

    it('falls back and flags fallback confidence when the oracle is absent', () => {
      const cost = estimateRebalanceCost({
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        amount: '1000000000',
        assetDecimals: 6,
        assetUsd: 1,
        sameAsset: true,
        priceImpactBps: 0,
      })
      expect(cost.dataConfidence).toBe('fallback')
      expect(cost.fallbackReasons).toContain('fee_oracle_unavailable')
      expect(cost.breakdown.networkFeeUsd).toBeCloseTo(NETWORK_FEE_FALLBACK_USD)
    })

    it('falls back when the oracle is stale', () => {
      const stale = new Date(Date.now() - 60 * 60 * 1000)
      const cost = estimateRebalanceCost({
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        amount: '1000000000',
        assetDecimals: 6,
        assetUsd: 1,
        sameAsset: true,
        priceImpactBps: 0,
        feeSnapshot: { recommendedBaseFee: 100, fetchedAt: stale },
      })
      expect(cost.dataConfidence).toBe('fallback')
      expect(cost.fallbackReasons).toContain('fee_oracle_stale_or_invalid')
    })

    it('applies a fallback price impact for an un-simulated cross-asset move', () => {
      const cost = estimateRebalanceCost({
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        amount: '1000000000',
        assetDecimals: 6,
        assetUsd: 1,
        sameAsset: false, // cross-asset, no simulation
        feeSnapshot: { recommendedBaseFee: 100, fetchedAt: new Date() },
      })
      expect(cost.dataConfidence).toBe('fallback')
      expect(cost.priceImpactBps).toBe(25)
      expect(cost.fallbackReasons).toContain('price_impact_unavailable')
    })

    it('charges per-protocol entry/exit bps', () => {
      const cost = estimateRebalanceCost({
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        amount: '1000000000',
        assetDecimals: 6,
        assetUsd: 1,
        sameAsset: true,
        priceImpactBps: 0,
        feeSnapshot: { recommendedBaseFee: 100, fetchedAt: new Date() },
        protocolEntryExitBps: { Blend: 10, Luma: 5 },
      })
      expect(cost.protocolEntryExitBps).toBe(15)
      expect(cost.breakdown.protocolEntryExitPct).toBeCloseTo(0.15)
    })

    it('a tiny position is dominated by fixed network fee (dust is not worth moving)', () => {
      // No fee oracle → fallback fixed fee of $0.50. A $0.01 position has a
      // huge fee pct (5000%), so the payback gate will block the move.
      const cost = estimateRebalanceCost({
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        amount: '10000', // 0.01 USDC (6 decimals)
        assetDecimals: 6,
        assetUsd: 1,
        sameAsset: true,
        priceImpactBps: 0,
      })
      expect(cost.networkFeePctOfAmount).toBeGreaterThan(100)
    })
  })

  describe('computePaybackDays', () => {
    it('returns Infinity when there is no positive benefit', () => {
      expect(computePaybackDays(0.5, 0)).toBe(Infinity)
      expect(computePaybackDays(0.5, -1)).toBe(Infinity)
    })

    it('computes days to recoup positive cost over benefit', () => {
      // cost 0.1%, benefit 5% annual → benefit/day = 5/365 ≈ 0.0137; days ≈ 7.3
      const days = computePaybackDays(0.1, 5)
      expect(days).toBeCloseTo((0.1 / 5) * 365, 2)
    })
  })

  describe('passesPaybackGate', () => {
    const cost = (pct: number) =>
      ({
        totalCostPct: pct,
        networkFeeStroops: 0,
        networkFeePctOfAmount: 0,
        priceImpactBps: 0,
        protocolEntryExitBps: 0,
        breakdown: {} as any,
        dataConfidence: 'measured',
        fallbackReasons: [],
      }) as any

    it('allows a move that recoups quickly', () => {
      // cost 0.1%, from 3% to 8% → benefit 5 → payback ~7.3 days < 21.
      const gate = passesPaybackGate(cost(0.1), 3, 8)
      expect(gate.allowed).toBe(true)
    })

    it('rejects a move whose cost eats the gain (long payback)', () => {
      // cost 8%, benefit 5% → payback ~584 days.
      const gate = passesPaybackGate(cost(8), 3, 8)
      expect(gate.allowed).toBe(false)
    })

    it('rejects a move with no benefit regardless of cost', () => {
      const gate = passesPaybackGate(cost(0.1), 8, 8)
      expect(gate.allowed).toBe(false)
    })

    it('applies the congestion premium at high congestion (more reluctant)', () => {
      // benefit 100% (from 3 to 103). cost 0.5% → payback = 0.5/100*365 = 1.825 days,
      // which is far below 21 so it passes at EVERY level — not a good discriminator.
      // Choose a move whose payback sits between the tightened (high) and normal
      // horizons: cost 1.9% → payback = 1.9/100*365 = 6.935 days.
      //   normal max   = 21          → allowed
      //   high  max    = 21*0.5=10.5 → allowed (still under)
      // We need a payback between 10.5 and 21 to show the tightening. cost 4.0%
      // → payback = 4/100*365 = 14.6 days.
      const gateLow = passesPaybackGate(cost(4.0), 3, 103, 'low')
      const gateHigh = passesPaybackGate(cost(4.0), 3, 103, 'high')
      expect(gateLow.allowed).toBe(true) // 14.6 < 21
      expect(gateHigh.allowed).toBe(false) // 14.6 > 10.5 (tightened by premium)
      expect(gateHigh.paybackDays).toBeCloseTo(14.6, 1)
    })
  })

  describe('annualizedBenefitPct', () => {
    it('returns the APY delta', () => {
      expect(annualizedBenefitPct(3, 8)).toBe(5)
      expect(annualizedBenefitPct(8, 8)).toBe(0)
    })
  })
})
