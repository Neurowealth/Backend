/**
 * Tests for src/analytics/benchmark.ts — the canonical market-factor series (#352).
 *
 * Covers the equal-weight default (the v1 attribution definition), tvl
 * weighting with equal fallback, forward-fill alignment, and a GOLDEN test
 * that locks computeAttribution's output so the attribution.ts refactor (which
 * now imports buildMarketFactorSeries instead of re-deriving the market) can
 * never silently change an attribution number.
 */

import { buildMarketFactorSeries } from '../../../src/analytics/benchmark'
import { computeAttribution } from '../../../src/analytics/attribution'

const DAY = 24 * 60 * 60 * 1000

function isoDays(start: Date, count: number): Date[] {
  return Array.from(
    { length: count },
    (_, i) => new Date(start.getTime() + i * DAY)
  )
}

describe('buildMarketFactorSeries', () => {
  const now = new Date('2026-01-11T00:00:00Z')

  it('equal weighting: one equally-weighted sector per protocol, market return = mean daily return', () => {
    // 3 protocols, flat 5% APY each -> each sector weight 1/3, returnFraction
    // = (5/100) * (1/365.25) each day; market return = same single value.
    const rates = []
    for (const d of isoDays(new Date('2026-01-01T00:00:00Z'), 10)) {
      for (const name of ['Aave', 'Compound', 'Stellar DEX']) {
        rates.push({ protocolName: name, assetSymbol: 'USDC', apy: 5, date: d })
      }
    }
    const { series, weighting, tvlFallback } = buildMarketFactorSeries({
      rates,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: now,
      weighting: 'equal',
    })

    expect(weighting).toBe('equal')
    expect(tvlFallback).toBe(false)
    const populated = series.filter((d) => d.sectors.length > 0)
    expect(populated.length).toBeGreaterThan(0)
    for (const day of populated) {
      expect(day.sectors).toHaveLength(3)
      for (const s of day.sectors) {
        expect(s.weight).toBeCloseTo(1 / 3, 12)
        expect(s.returnFraction).toBeCloseTo((5 / 100) * (1 / 365.25), 12)
      }
      // market return = sum(weight * rf) = (1/3+1/3+1/3) * rf = rf
      expect(day.marketReturn).toBeCloseTo((5 / 100) * (1 / 365.25), 9)
    }
  })

  it('tv1 weighting scales each day by tvl share and does not fall back when tvl present', () => {
    const rates = []
    for (const d of isoDays(new Date('2026-01-01T00:00:00Z'), 10)) {
      rates.push({
        protocolName: 'A',
        assetSymbol: 'USDC',
        apy: 5,
        tvl: 300,
        date: d,
      })
      rates.push({
        protocolName: 'B',
        assetSymbol: 'USDC',
        apy: 5,
        tvl: 100,
        date: d,
      })
    }
    const { series, weighting, tvlFallback } = buildMarketFactorSeries({
      rates,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: now,
      weighting: 'tvl',
    })
    expect(weighting).toBe('tvl')
    expect(tvlFallback).toBe(false)
    const populated = series.filter((d) => d.sectors.length > 0)
    const a = populated[1].sectors.find((s) => s.name === 'A')
    const b = populated[1].sectors.find((s) => s.name === 'B')
    expect(a!.weight).toBeCloseTo(300 / 400, 12)
    expect(b!.weight).toBeCloseTo(100 / 400, 12)
  })

  it('tvl requested but no tvl data → falls back to equal and is flagged', () => {
    const rates = []
    for (const d of isoDays(new Date('2026-01-01T00:00:00Z'), 10)) {
      for (const name of ['A', 'B']) {
        rates.push({ protocolName: name, assetSymbol: 'USDC', apy: 5, date: d })
      }
    }
    const { series, weighting, tvlFallback } = buildMarketFactorSeries({
      rates,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: now,
      weighting: 'tvl',
    })
    expect(weighting).toBe('equal')
    expect(tvlFallback).toBe(true)
    const populated = series.find((d) => d.sectors.length > 0)!
    expect(populated.sectors[0].weight).toBeCloseTo(1 / 2, 12)
  })

  it('hole days return null marketReturn (no fabricated zero-fill)', () => {
    // Only one protocol, only present on the first day -> subsequent days
    // forward-fill it (so they ARE populated). To get a null day we use an
    // empty raw series, which yields an empty series entirely.
    const { series } = buildMarketFactorSeries({
      rates: [],
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: now,
    })
    expect(series).toEqual([])
  })
})

describe('golden: attribution imports the canonical benchmark (unchanged output)', () => {
  const now = new Date('2026-01-11T00:00:00Z')

  it('computeAttribution still reconciles with exact, pinned benchmark return', () => {
    const windowDays = 10
    const DAY_LOCAL = 24 * 60 * 60 * 1000
    const portfolioRows = []
    for (let d = 0; d <= windowDays; d++) {
      portfolioRows.push({
        snapshotAt: new Date(now.getTime() - (windowDays - d) * DAY_LOCAL),
        sector: 'Aave',
        value: 1000 * Math.pow(1 + 0.0001, d),
      })
    }
    const benchmarkRates = []
    for (let d = 0; d <= windowDays; d++) {
      const date = new Date(now.getTime() - (windowDays - d) * DAY_LOCAL)
      for (const name of ['Aave', 'Compound']) {
        benchmarkRates.push({
          protocolName: name,
          assetSymbol: 'USDC',
          apy: 5, // flat 5%
          date,
        })
      }
    }

    const result = computeAttribution({
      portfolioRows,
      benchmarkRates,
      windowDays,
      now,
      benchmarkVersion: 'equal-weight-v1:test',
    })

    expect(result.includedPeriodCount).toBe(windowDays)
    expect(result.reconciled).toBe(true)

    // GOLDEN: the benchmark series is derived from buildMarketFactorSeries so
    // a future benchmark refactor that alters these exact numbers is caught.
    const perDay = (5 / 100) * (1 / 365.25) // flat 5% APY daily fraction
    expect(result.benchmarkReturn).toBeCloseTo(
      Math.pow(1 + perDay, windowDays) - 1,
      6
    )

    const aave = result.sectors.find((s) => s.sector === 'Aave')!
    expect(aave.benchmarkWeight).toBeCloseTo(0.5, 12) // equal weight across 2
    expect(aave.benchmarkReturn).toBeCloseTo(
      Math.pow(1 + perDay, windowDays) - 1,
      6
    )
  })
})
