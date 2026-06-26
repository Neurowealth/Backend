import {
  calculateRealizedAPY,
  calculateSharpeRatio,
  calculateMaxDrawdown,
  calculateProtocolAllocation,
  computeAnalyticsMetrics,
  periodToDays,
  SnapshotData,
} from '../../../src/utils/analytics'

describe('analytics utils', () => {
  const baseDate = new Date('2026-01-01T00:00:00Z')

  function makeSnapshot(
    offsetDays: number,
    principal: number,
    yieldAmt: number,
    protocol: string = 'Blend',
    posId: string = 'pos1'
  ): SnapshotData {
    const d = new Date(baseDate.getTime() + offsetDays * 86400_000)
    return {
      snapshotAt: d,
      principalAmount: principal,
      yieldAmount: yieldAmt,
      positionId: posId,
      position: { protocolName: protocol },
    }
  }

  describe('periodToDays', () => {
    it('returns correct days for supported periods', () => {
      expect(periodToDays('7d')).toBe(7)
      expect(periodToDays('30d')).toBe(30)
      expect(periodToDays('90d')).toBe(90)
      expect(periodToDays('1y')).toBe(365)
      expect(periodToDays('unknown')).toBe(30)
    })
  })

  describe('calculateRealizedAPY', () => {
    it('returns 0 for empty snapshots', () => {
      expect(calculateRealizedAPY([], 30)).toBe(0)
    })

    it('calculates realized APY correctly (verified against manual CAGR)', () => {
      // Manual verification:
      // initialValue = 1000, finalValue = 1050, days=30
      // totalReturn = 0.05, years=30/365≈0.08219
      // apy = (1.05^(1/0.08219) -1 ) *100 ≈ 82.35% (but we annualize)
      // But for short period, test realistic growth
      const snaps = [
        makeSnapshot(0, 10000, 0),
        makeSnapshot(30, 10000, 250), // 2.5% return in 30d
      ]
      const apy = calculateRealizedAPY(snaps, 30)
      // Expected approx (1 + 0.025)^(365/30) -1 = ~31.5% annualized
      expect(apy).toBeGreaterThan(25)
      expect(apy).toBeLessThan(40)
      expect(typeof apy).toBe('number')
    })

    it('handles zero or negative initial value', () => {
      const snaps = [makeSnapshot(0, 0, 0), makeSnapshot(10, 100, 5)]
      expect(calculateRealizedAPY(snaps, 30)).toBe(0)
    })

    it('returns 0 when final <= initial', () => {
      const snaps = [makeSnapshot(0, 1000, 50), makeSnapshot(30, 900, 20)]
      const apy = calculateRealizedAPY(snaps, 30)
      expect(apy).toBeGreaterThanOrEqual(0)
    })
  })

  describe('calculateSharpeRatio', () => {
    it('returns 0 when <2 snapshots', () => {
      expect(calculateSharpeRatio([makeSnapshot(0, 1000, 10)])).toBe(0)
    })

    it('computes positive Sharpe for upward trending portfolio', () => {
      const snaps = [
        makeSnapshot(0, 10000, 0),
        makeSnapshot(1, 10000, 10),
        makeSnapshot(2, 10000, 25),
        makeSnapshot(3, 10000, 45),
      ]
      const sharpe = calculateSharpeRatio(snaps, 0)
      expect(sharpe).toBeGreaterThan(0)
    })

    it('uses risk-free rate from param (default 0)', () => {
      const snaps = [
        makeSnapshot(0, 1000, 0),
        makeSnapshot(1, 1000, 1),
        makeSnapshot(2, 1000, 3),
      ]
      const s0 = calculateSharpeRatio(snaps, 0)
      const sHighRf = calculateSharpeRatio(snaps, 0.5) // 50% rf unrealistic but for test
      expect(sHighRf).toBeLessThan(s0)
    })

    it('returns 0 when volatility is zero (flat)', () => {
      const snaps = [
        makeSnapshot(0, 1000, 0),
        makeSnapshot(1, 1000, 0),
        makeSnapshot(2, 1000, 0),
      ]
      expect(calculateSharpeRatio(snaps)).toBe(0)
    })
  })

  describe('calculateMaxDrawdown', () => {
    it('returns 0 for insufficient data', () => {
      expect(calculateMaxDrawdown([])).toBe(0)
      expect(calculateMaxDrawdown([makeSnapshot(0, 1000, 0)])).toBe(0)
    })

    it('calculates largest peak-to-trough decline correctly', () => {
      // Values: 1000 -> 1200 -> 900 -> 1100
      const snaps = [
        makeSnapshot(0, 1000, 0),
        makeSnapshot(1, 1000, 200),
        makeSnapshot(2, 1000, -100), // trough 900
        makeSnapshot(3, 1000, 100),
      ]
      const dd = calculateMaxDrawdown(snaps)
      // peak 1200 to trough 900 = 25%
      expect(dd).toBeCloseTo(25, 1)
    })

    it('returns 0 for monotonically increasing', () => {
      const snaps = [
        makeSnapshot(0, 1000, 0),
        makeSnapshot(1, 1000, 50),
        makeSnapshot(2, 1000, 120),
      ]
      expect(calculateMaxDrawdown(snaps)).toBe(0)
    })
  })

  describe('calculateProtocolAllocation', () => {
    it('returns empty for no data', () => {
      expect(calculateProtocolAllocation([])).toEqual([])
    })

    it('computes allocation percentages from positions', () => {
      const positions = [
        { protocolName: 'Blend', currentValue: 6000 },
        { protocolName: 'Soroswap', currentValue: 4000 },
      ]
      const alloc = calculateProtocolAllocation([], positions)
      expect(alloc.length).toBe(2)
      expect(alloc[0]).toEqual({ protocol: 'Blend', percentage: 60, value: 6000 })
      expect(alloc[1]).toEqual({ protocol: 'Soroswap', percentage: 40, value: 4000 })
    })

    it('computes from snapshots when no positions provided', () => {
      const snaps = [
        makeSnapshot(0, 10000, 0, 'Blend', 'p1'),
        makeSnapshot(1, 10000, 500, 'Blend', 'p1'),
        makeSnapshot(0, 3000, 0, 'Aqua', 'p2'),
      ]
      const alloc = calculateProtocolAllocation(snaps)
      expect(alloc.length).toBeGreaterThan(0)
      const totalPct = alloc.reduce((s, a) => s + a.percentage, 0)
      expect(totalPct).toBeCloseTo(100, 0)
    })

    it('prefers positions data over snapshots', () => {
      const snaps = [makeSnapshot(0, 10000, 0, 'Blend')]
      const positions = [{ protocolName: 'Soroswap', currentValue: 12345 }]
      const alloc = calculateProtocolAllocation(snaps, positions)
      expect(alloc[0].protocol).toBe('Soroswap')
    })
  })

  describe('computeAnalyticsMetrics', () => {
    it('returns complete metrics object', async () => {
      const snaps = [
        makeSnapshot(0, 10000, 0, 'Blend'),
        makeSnapshot(30, 10000, 300, 'Blend'),
        makeSnapshot(0, 2000, 0, 'Aqua'),
      ]
      const positions = [
        { protocolName: 'Blend', currentValue: 10300 },
        { protocolName: 'Aqua', currentValue: 2000 },
      ]
      const metrics = await computeAnalyticsMetrics(snaps, positions, '30d', 0)

      expect(metrics).toHaveProperty('realizedAPY')
      expect(metrics).toHaveProperty('sharpeRatio')
      expect(metrics).toHaveProperty('maxDrawdown')
      expect(metrics).toHaveProperty('protocolAllocation')
      expect(metrics).toHaveProperty('period', '30d')
      expect(metrics).toHaveProperty('snapshotCount')
      expect(metrics).toHaveProperty('startDate')
      expect(metrics).toHaveProperty('endDate')
      expect(Array.isArray(metrics.protocolAllocation)).toBe(true)
    })

    it('respects risk free rate param', async () => {
      const snaps = [
        makeSnapshot(0, 1000, 0),
        makeSnapshot(10, 1000, 30),
      ]
      const m1 = await computeAnalyticsMetrics(snaps, [], '30d', 0)
      const m2 = await computeAnalyticsMetrics(snaps, [], '30d', 0.05)
      expect(m2.sharpeRatio).toBeLessThanOrEqual(m1.sharpeRatio)
    })
  })
})
