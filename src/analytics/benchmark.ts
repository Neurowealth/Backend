/**
 * Market-factor benchmark series (#352) — pure computation.
 *
 * This is the SINGLE place the DeFi-yield "market" is defined across
 * src/analytics/. v1 defines "the market" as a daily average of available
 * `ProtocolRate` APY history — no real traded index exists yet. Every analyzer
 * that needs a market series (attribution today, factor exposure next) imports
 * `buildMarketFactorSeries` from here instead of re-deriving the definition.
 *
 * ─── UNITS ───────────────────────────────────────────────────────────────────
 *
 * `ProtocolRate.supplyApy` is an ANNUAL rate quote. A benchmark is a series of
 * RETURNS, so each day's sector contribution is the daily-accrued fraction of
 * that annual APY:
 *
 *   returnFraction = (supplyApy / 100) * YEAR_FRACTION_PER_DAY
 *
 * using the identical year convention as src/agent/backtest.ts
 * (365.25 days/year). The aggregate market return for a day is the
 * weight-weighted sum of those fractions.
 *
 * ─── WEIGHTING ────────────────────────────────────────────────────────────────
 *
 * - `equal` (default): every protocol that has a rate quote on a given day is
 *   one equally-weighted member of that day's benchmark — the exact v1
 *   attribution definition, promoted to be shared.
 * - `tvl`: weights by the protocol's TVL on that day. TVL is carried forward
 *   day-over-day exactly like APY (see below). When no TVL is available for a
 *   day (all protocols missing TVL, or total TVL <= 0) the day falls back to
 *   equal weighting; the overall series is flagged `tvlFallback: true` if any
 *   populated day could not use TVL.
 *
 * ─── GAP-HANDLING ────────────────────────────────────────────────────────────
 *
 * Reuses the exact forward-fill policy from `buildDailyRateSeries`
 * (src/agent/backtest.ts): a protocol with no observation for a day holds its
 * last known APY and TVL; a protocol with no observations up to and including
 * a day is absent that day. This guarantees alignment with every other series
 * built by `buildDailyRateSeries` so a portfolio series and the market series
 * can never disagree about which days exist.
 *
 * Zero I/O, deterministic, unit tested — src/jobs/attribution.ts and
 * src/analytics/factorExposure.ts read the DB and call in here.
 */

import { RawProtocolRatePoint } from '../agent/backtest'
import { buildDailyRateSeries } from '../agent/backtest'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_YEAR = 365.25 * MS_PER_DAY
const YEAR_FRACTION_PER_DAY = MS_PER_DAY / MS_PER_YEAR

/** A benchmark rate observation — `RawProtocolRatePoint` plus optional TVL for weighting. */
export interface BenchmarkRatePoint extends RawProtocolRatePoint {
  /** Protocol TVL for the sampled day, used by `tvl` weighting. Missing => day falls back to equal. */
  tvl?: number | null
}

export type BenchmarkWeighting = 'equal' | 'tvl'

/** One protocol's contribution to one day's market factor. */
export interface BenchmarkSectorPoint {
  name: string
  /** Market weight of this protocol this day (sums to 1 over the day's sectors). */
  weight: number
  /** Daily-accrued return fraction for this sector ((apy/100) * YEAR_FRACTION_PER_DAY). */
  returnFraction: number
}

/** One day of the market factor series. */
export interface MarketFactorDay {
  date: Date
  /** Aggregate market daily return = sum(weight * returnFraction); null when no sectors. */
  marketReturn: number | null
  /** Per-protocol weights/returns this day — the benchmark's sector decomposition. */
  sectors: BenchmarkSectorPoint[]
}

export interface MarketFactorSeries {
  series: MarketFactorDay[]
  /** The weighting actually applied (`'equal'` if a `tvl` request fell back). */
  weighting: BenchmarkWeighting
  /** True when `tvl` was requested but at least one populated day fell back to equal. */
  tvlFallback: boolean
}

export interface BuildMarketFactorInput {
  /** Raw ProtocolRate observations (optionally carrying tvl), any order, possibly gappy. */
  rates: BenchmarkRatePoint[]
  startDate: Date
  endDate: Date
  /** 'equal' (default) or 'tvl'. */
  weighting?: BenchmarkWeighting
}

/**
 * Build the daily market-factor RETURN series on the aligned grid shared with
 * `buildDailyRateSeries`. Equal weighting is default; `tvl` falls back to
 * equal per-day when TVL is unavailable, flagged on the result.
 */
export function buildMarketFactorSeries(
  input: BuildMarketFactorInput
): MarketFactorSeries {
  const weighting = input.weighting ?? 'equal'

  // Reuse backtest's forward-fill to get the per-day available protocol set
  // and APY — guarantees the factor series is index-aligned with any series
  // attribution/estimation already build from the same raw rates.
  const apyPoints: RawProtocolRatePoint[] = input.rates.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    apy: r.apy,
    date: r.date,
  }))
  const { series: dailyRateSeries } = buildDailyRateSeries(
    apyPoints,
    input.startDate,
    input.endDate
  )

  // Parallel forward-fill for TVL (only needed for tvl weighting).
  const tvlSorted = new Map<string, { tvl: number; date: Date }[]>()
  for (const r of input.rates) {
    if (r.tvl == null || !Number.isFinite(r.tvl)) continue
    const list = tvlSorted.get(r.protocolName) ?? []
    list.push({ tvl: r.tvl, date: r.date })
    tvlSorted.set(r.protocolName, list)
  }
  for (const [name, list] of tvlSorted) {
    list.sort((a, b) => a.date.getTime() - b.date.getTime())
  }
  const tvlPointer = new Map<string, number>()
  const tvlHeld = new Map<string, number>()
  const hasAnyTvl = tvlSorted.size > 0

  const out: MarketFactorDay[] = []
  let anyTvlDay = false
  let anyPopulatedEqualFallback = false

  for (const day of dailyRateSeries) {
    // Advance TVL forward-fill to this day.
    for (const [name, list] of tvlSorted) {
      let idx = tvlPointer.get(name) ?? 0
      while (
        idx < list.length &&
        list[idx].date.getTime() <= day.date.getTime()
      ) {
        tvlHeld.set(name, list[idx].tvl)
        idx++
      }
      tvlPointer.set(name, idx)
    }

    if (day.protocols.length === 0) {
      out.push({ date: day.date, marketReturn: null, sectors: [] })
      continue
    }

    const wantTvl = weighting === 'tvl' && hasAnyTvl
    let totalTvl = 0
    const tvlForDay = new Map<string, number>()
    if (wantTvl) {
      for (const p of day.protocols) {
        const tvl = tvlHeld.get(p.name)
        if (tvl != null && tvl > 0) {
          tvlForDay.set(p.name, tvl)
          totalTvl += tvl
        }
      }
    }

    const useTvl = wantTvl && totalTvl > 0 && tvlForDay.size > 0
    if (useTvl) anyTvlDay = true
    else if (weighting === 'tvl') anyPopulatedEqualFallback = true

    const sectors: BenchmarkSectorPoint[] = []
    let marketReturn = 0
    for (const p of day.protocols) {
      const rf = (p.apy / 100) * YEAR_FRACTION_PER_DAY
      let w: number
      if (useTvl) {
        w = (tvlForDay.get(p.name) ?? 0) / totalTvl
      } else {
        w = 1 / day.protocols.length
      }
      sectors.push({ name: p.name, weight: w, returnFraction: rf })
      marketReturn += w * rf
    }

    out.push({ date: day.date, marketReturn, sectors })
  }

  const appliedWeighting: BenchmarkWeighting =
    weighting === 'equal' || !anyTvlDay ? 'equal' : 'tvl'

  return {
    series: out,
    weighting: appliedWeighting,
    tvlFallback: weighting === 'tvl' && anyPopulatedEqualFallback,
  }
}
