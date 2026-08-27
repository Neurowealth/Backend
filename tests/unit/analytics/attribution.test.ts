import {
  brinsonPeriod,
  buildDailyPortfolioSectorSeries,
  carinoFactor,
  computeAttribution,
  linkPeriods,
  RECONCILIATION_TOLERANCE,
  SectorState,
  LinkedPeriodInput,
} from '../../../src/analytics/attribution'
import {
  bucketByInstant,
  SnapshotRow,
} from '../../../src/agent/strategyMetrics'
import { RawProtocolRatePoint } from '../../../src/agent/backtest'

const DAY = 24 * 60 * 60 * 1000

describe('brinsonPeriod', () => {
  it('splits a single sector into allocation + selection satisfying the exact identity', () => {
    const state: SectorState = {
      sector: 'Aave',
      portfolioWeight: 0.6,
      portfolioReturn: 0.02,
      benchmarkWeight: 0.4,
      benchmarkReturn: 0.01,
    }
    const result = brinsonPeriod([state])
    const [effect] = result.sectors

    // allocation + selection === w_p*r_p - w_b*r_b (the header's telescoping identity)
    const expected =
      state.portfolioWeight * (state.portfolioReturn as number) -
      state.benchmarkWeight * (state.benchmarkReturn as number)
    expect(effect.allocationEffect + effect.selectionEffect).toBeCloseTo(
      expected,
      12
    )
  })

  it('sums allocation + selection across sectors to R_p - R_b', () => {
    const states: SectorState[] = [
      {
        sector: 'Aave',
        portfolioWeight: 0.7,
        portfolioReturn: 0.03,
        benchmarkWeight: 0.5,
        benchmarkReturn: 0.02,
      },
      {
        sector: 'Compound',
        portfolioWeight: 0.3,
        portfolioReturn: -0.01,
        benchmarkWeight: 0.5,
        benchmarkReturn: 0.015,
      },
    ]
    const result = brinsonPeriod(states)
    const totalEffect = result.sectors.reduce(
      (s, e) => s + e.allocationEffect + e.selectionEffect,
      0
    )
    expect(totalEffect).toBeCloseTo(
      result.portfolioReturn - result.benchmarkReturn,
      12
    )
  })

  it('a sector the portfolio does not hold contributes pure benchmark allocation effect, not dropped', () => {
    const state: SectorState = {
      sector: 'Yieldblox',
      portfolioWeight: 0,
      portfolioReturn: null,
      benchmarkWeight: 0.25,
      benchmarkReturn: 0.012,
    }
    const result = brinsonPeriod([state])
    expect(result.sectors).toHaveLength(1)
    expect(result.sectors[0].allocationEffect).toBeCloseTo(-0.25 * 0.012, 12)
    expect(result.sectors[0].selectionEffect).toBe(0)
  })

  it('never produces NaN when weight is 0 and return is null (0 * null guard)', () => {
    const state: SectorState = {
      sector: 'Empty',
      portfolioWeight: 0,
      portfolioReturn: null,
      benchmarkWeight: 0.5,
      benchmarkReturn: 0.01,
    }
    const result = brinsonPeriod([state])
    expect(Number.isNaN(result.sectors[0].selectionEffect)).toBe(false)
    expect(result.sectors[0].selectionEffect).toBe(0)
  })

  it('a sector with no benchmark data flows into unattributed, not a fabricated effect', () => {
    const state: SectorState = {
      sector: 'NewProtocol',
      portfolioWeight: 0.2,
      portfolioReturn: 0.05,
      benchmarkWeight: 0,
      benchmarkReturn: null,
    }
    const result = brinsonPeriod([state])
    expect(result.sectors).toHaveLength(0)
    expect(result.unattributed).toBeCloseTo(0.2 * 0.05, 12)
  })

  it('an empty-to-funded transition (0 starting weight) contributes 0 portfolio return, not Infinity', () => {
    const state: SectorState = {
      sector: 'Aave',
      portfolioWeight: 0, // portfolio started this period with nothing
      portfolioReturn: null,
      benchmarkWeight: 1,
      benchmarkReturn: 0.01,
    }
    const result = brinsonPeriod([state])
    expect(result.portfolioReturn).toBe(0)
    expect(Number.isFinite(result.portfolioReturn)).toBe(true)
    // Still credits the pure benchmark allocation effect for the gap.
    expect(result.sectors[0].allocationEffect).toBeCloseTo(-1 * 0.01, 12)
  })
})

describe('carinoFactor', () => {
  it('matches the closed-form ratio when returns differ', () => {
    const k = carinoFactor(0.05, 0.02)
    const expected = (Math.log(1.05) - Math.log(1.02)) / (0.05 - 0.02)
    expect(k).toBeCloseTo(expected, 12)
  })

  it('uses the removable-singularity limit when returns are equal', () => {
    const k = carinoFactor(0.03, 0.03)
    expect(k).toBeCloseTo(1 / 1.03, 12)
  })

  it('returns null (never Infinity) on a total wipeout', () => {
    expect(carinoFactor(-1, 0.01)).toBeNull()
    expect(carinoFactor(0.01, -1)).toBeNull()
    expect(carinoFactor(-1.5, 0.01)).toBeNull()
  })
})

describe('linkPeriods', () => {
  it('reconciles linked totals to the compounded portfolio-vs-benchmark excess return', () => {
    const periods: LinkedPeriodInput[] = [
      {
        portfolioReturn: 0.001,
        benchmarkReturn: 0.0005,
        sectors: [
          { sector: 'Aave', allocationEffect: 0.0002, selectionEffect: 0.0003 },
        ],
        unattributed: 0,
      },
      {
        portfolioReturn: -0.0008,
        benchmarkReturn: 0.0002,
        sectors: [
          {
            sector: 'Aave',
            allocationEffect: -0.0004,
            selectionEffect: -0.0006,
          },
        ],
        unattributed: 0,
      },
      {
        portfolioReturn: 0.0015,
        benchmarkReturn: 0.001,
        sectors: [
          { sector: 'Aave', allocationEffect: 0.0002, selectionEffect: 0.0003 },
        ],
        unattributed: 0,
      },
    ]

    const linked = linkPeriods(periods)
    expect(linked).not.toBeNull()
    const l = linked!

    const compoundedP =
      periods.reduce((acc, p) => acc * (1 + p.portfolioReturn), 1) - 1
    const compoundedB =
      periods.reduce((acc, p) => acc * (1 + p.benchmarkReturn), 1) - 1

    expect(l.portfolioReturn).toBeCloseTo(compoundedP, 12)
    expect(l.benchmarkReturn).toBeCloseTo(compoundedB, 12)
    expect(
      l.allocationEffect + l.selectionEffect + l.unattributedEffect
    ).toBeCloseTo(compoundedP - compoundedB, 9)
    expect(Math.abs(l.reconciliationGap)).toBeLessThanOrEqual(
      RECONCILIATION_TOLERANCE
    )
    expect(l.reconciled).toBe(true)

    // Per-sector linked effects must also sum to the linked totals (single sector here).
    const sectorTotal = l.sectorEffects.get('Aave')
    expect(sectorTotal!.allocationEffect).toBeCloseTo(l.allocationEffect, 9)
    expect(sectorTotal!.selectionEffect).toBeCloseTo(l.selectionEffect, 9)
  })

  it('returns null for an empty period list', () => {
    expect(linkPeriods([])).toBeNull()
  })

  it('reports an explicit reconciliationGap rather than fudging when a period is a wipeout', () => {
    const periods: LinkedPeriodInput[] = [
      {
        portfolioReturn: -1, // total loss this period — carinoFactor(-1, x) is null
        benchmarkReturn: 0.01,
        sectors: [
          { sector: 'Aave', allocationEffect: 0, selectionEffect: -0.5 },
        ],
        unattributed: 0,
      },
      {
        portfolioReturn: 0.01,
        benchmarkReturn: 0.01,
        sectors: [{ sector: 'Aave', allocationEffect: 0, selectionEffect: 0 }],
        unattributed: 0,
      },
    ]
    const linked = linkPeriods(periods)
    expect(linked).not.toBeNull()
    // The wipeout period's effects are excluded from the linked sum by
    // construction, so the identity legitimately does not hold — surfaced as
    // a real, non-fudged gap rather than NaN or a forced match.
    expect(Number.isFinite(linked!.reconciliationGap)).toBe(true)
    expect(Number.isNaN(linked!.allocationEffect)).toBe(false)
  })
})

describe('buildDailyPortfolioSectorSeries', () => {
  const start = new Date('2026-01-01T00:00:00Z')
  const end = new Date('2026-01-03T00:00:00Z')

  it('takes the latest snapshot per (sector, day) regardless of row order', () => {
    const rows = [
      {
        snapshotAt: new Date('2026-01-01T09:00:00Z'),
        sector: 'Aave',
        value: 100,
      },
      {
        snapshotAt: new Date('2026-01-01T21:00:00Z'),
        sector: 'Aave',
        value: 110,
      },
      {
        snapshotAt: new Date('2026-01-01T15:00:00Z'),
        sector: 'Aave',
        value: 105,
      },
    ]
    // Shuffle order deliberately.
    const shuffled = [rows[2], rows[0], rows[1]]
    const series = buildDailyPortfolioSectorSeries(shuffled, start, end)
    expect(series[0].values['Aave']).toBe(110)
  })

  it('a day with no row for a sector reports it as not held (absent), not stale', () => {
    const rows = [
      {
        snapshotAt: new Date('2026-01-01T09:00:00Z'),
        sector: 'Aave',
        value: 100,
      },
      // No row for 2026-01-02 — position closed.
      {
        snapshotAt: new Date('2026-01-03T09:00:00Z'),
        sector: 'Compound',
        value: 50,
      },
    ]
    const series = buildDailyPortfolioSectorSeries(rows, start, end)
    expect(series).toHaveLength(3)
    expect(series[0].values['Aave']).toBe(100)
    expect(series[1].values['Aave']).toBeUndefined()
    expect(series[2].values['Aave']).toBeUndefined()
  })

  it('produces windowDays+1 grid points spanning the window', () => {
    const series = buildDailyPortfolioSectorSeries([], start, end)
    expect(series).toHaveLength(3)
    expect(series[0].date.getTime()).toBe(start.getTime())
    expect(series[2].date.getTime()).toBe(end.getTime())
  })
})

describe('computeAttribution — integration', () => {
  const now = new Date('2026-01-11T00:00:00Z')

  function makeBenchmarkRates(
    days: number,
    protocols: string[]
  ): RawProtocolRatePoint[] {
    const points: RawProtocolRatePoint[] = []
    for (let d = 0; d <= days; d++) {
      const date = new Date(now.getTime() - (days - d) * DAY)
      for (const name of protocols) {
        points.push({
          protocolName: name,
          assetSymbol: 'USDC',
          apy: 5, // flat 5% APY for every protocol, every day
          date,
        })
      }
    }
    return points
  }

  it('reconciles for a simple flat-benchmark, flat-portfolio fixture', () => {
    const windowDays = 10
    const portfolioRows = []
    for (let d = 0; d <= windowDays; d++) {
      portfolioRows.push({
        snapshotAt: new Date(now.getTime() - (windowDays - d) * DAY),
        sector: 'Aave',
        value: 1000 * Math.pow(1 + 0.0001, d), // small steady growth
      })
    }

    const result = computeAttribution({
      portfolioRows,
      benchmarkRates: makeBenchmarkRates(windowDays, ['Aave', 'Compound']),
      windowDays,
      now,
      benchmarkVersion: 'equal-weight-v1:test',
    })

    expect(result.includedPeriodCount).toBe(windowDays)
    expect(result.reconciled).toBe(true)
    expect(Math.abs(result.reconciliationGap)).toBeLessThanOrEqual(
      RECONCILIATION_TOLERANCE
    )

    const aave = result.sectors.find((s) => s.sector === 'Aave')
    const compound = result.sectors.find((s) => s.sector === 'Compound')
    expect(aave).toBeDefined()
    expect(compound).toBeDefined()
    // Compound is never held by the portfolio: pure benchmark allocation effect.
    expect(compound!.portfolioWeight).toBe(0)
    expect(compound!.portfolioReturn).toBeNull()
  })

  it('a sector held by the portfolio but entirely missing from the benchmark is unattributed, not dropped', () => {
    const windowDays = 5
    const portfolioRows = []
    for (let d = 0; d <= windowDays; d++) {
      portfolioRows.push({
        snapshotAt: new Date(now.getTime() - (windowDays - d) * DAY),
        sector: 'ExoticProtocol',
        value: 500 + d * 5,
      })
    }

    const result = computeAttribution({
      portfolioRows,
      benchmarkRates: makeBenchmarkRates(windowDays, ['Aave']), // ExoticProtocol never quoted
      windowDays,
      now,
      benchmarkVersion: 'equal-weight-v1:test',
    })

    // Still reported (weight/return are known), but with zero allocation/selection
    // effect — its contribution flows through `unattributedEffect` instead, since
    // there is no benchmark comparator to decompose it against.
    const exotic = result.sectors.find((s) => s.sector === 'ExoticProtocol')
    expect(exotic).toBeDefined()
    expect(exotic!.allocationEffect).toBe(0)
    expect(exotic!.selectionEffect).toBe(0)
    expect(result.unattributedEffect).not.toBe(0)
    expect(
      Math.abs(
        result.allocationEffect +
          result.selectionEffect +
          result.unattributedEffect -
          (result.portfolioReturn - result.benchmarkReturn)
      )
    ).toBeLessThanOrEqual(RECONCILIATION_TOLERANCE)
  })

  it('an empty portfolio (no rows) returns a degenerate, finite, unattributed result — never Infinity/NaN', () => {
    const result = computeAttribution({
      portfolioRows: [],
      benchmarkRates: makeBenchmarkRates(10, ['Aave']),
      windowDays: 10,
      now,
      benchmarkVersion: 'equal-weight-v1:test',
    })
    expect(Number.isFinite(result.portfolioReturn)).toBe(true)
    expect(Number.isFinite(result.allocationEffect)).toBe(true)
    expect(Number.isFinite(result.selectionEffect)).toBe(true)
    expect(Number.isNaN(result.reconciliationGap)).toBe(false)
  })

  it('no benchmark data at all returns the empty degenerate result', () => {
    const result = computeAttribution({
      portfolioRows: [{ snapshotAt: now, sector: 'Aave', value: 100 }],
      benchmarkRates: [],
      windowDays: 10,
      now,
      benchmarkVersion: 'equal-weight-v1:test',
    })
    expect(result.includedPeriodCount).toBe(0)
    expect(result.reconciled).toBe(true)
    expect(result.sectors).toEqual([])
  })
})

describe('anti-divergence: attribution shares the canonical value-series definition', () => {
  it('the whole-portfolio value at a given day matches bucketByInstant on the same rows', () => {
    const at = new Date('2026-02-01T12:00:00Z')
    const rows: SnapshotRow[] = [
      { snapshotAt: at, principalAmount: 100, yieldAmount: 5 }, // position A
      { snapshotAt: at, principalAmount: 200, yieldAmount: 10 }, // position B
    ]
    const sectorRows = [
      { snapshotAt: at, sector: 'Aave', value: 105 },
      { snapshotAt: at, sector: 'Compound', value: 210 },
    ]

    const [wholePortfolioPoint] = bucketByInstant(rows)
    const dailySeries = buildDailyPortfolioSectorSeries(sectorRows, at, at)
    const totalFromAttribution = Object.values(dailySeries[0].values).reduce(
      (s, v) => s + v,
      0
    )

    expect(totalFromAttribution).toBeCloseTo(wholePortfolioPoint.value, 12)
  })
})
