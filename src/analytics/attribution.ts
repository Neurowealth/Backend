/**
 * Performance attribution — pure computation (#320).
 *
 * Decomposes a portfolio's (or a published strategy's) return, relative to a
 * benchmark, into a Brinson-style allocation effect and selection effect,
 * linked across daily periods. Zero I/O, deterministic, unit tested against
 * fixture series — src/jobs/attribution.ts is the only thing that reads the DB
 * and calls in here, mirroring src/agent/strategyMetrics.ts /
 * src/jobs/strategyMetrics.ts.
 *
 * ─── THE SAME CORRECTNESS TRAP AS strategyMetrics.ts ─────────────────────────
 *
 * `YieldSnapshot.apy` is a cumulative running average, never a period return
 * (docs/STRATEGY_MARKETPLACE.md §2). Attribution is computed from portfolio
 * VALUE (`principalAmount + yieldAmount`), bucketed per sector per day — never
 * from the raw `apy` column. `ProtocolRate.supplyApy` IS a rate quote and is
 * the correct input for the benchmark side, exactly as in
 * src/analytics/estimation.ts.
 *
 * ─── THE BENCHMARK, V1 ────────────────────────────────────────────────────────
 *
 * No real market index exists yet. v1 defines "the market" as the
 * EQUAL-WEIGHTED average of available `ProtocolRate` APY history — every
 * protocol with a rate quote on a given day counts as one equally-weighted
 * sector of the benchmark that day (or a configurable subset; see
 * src/jobs/attribution.ts). This module never reads `ProtocolRate` itself — it
 * accepts the raw observations as `RawProtocolRatePoint[]` (the same type
 * src/agent/backtest.ts already defines), so a real index feed can be dropped
 * in later by supplying a differently-sourced series in the same shape.
 *
 * ─── SECTORS, V1 ──────────────────────────────────────────────────────────────
 *
 * A "sector" is a protocol name. A protocol-to-sector map (grouping multiple
 * protocols into one sector) is a natural v2 extension but is out of scope
 * here — see docs/PERFORMANCE_ATTRIBUTION.md.
 *
 * ─── THE BRINSON MODEL, WITH INTERACTION FOLDED INTO SELECTION ───────────────
 *
 * For sector i in period t, with portfolio weight/return (w_p, r_p) and
 * benchmark weight/return (w_b, r_b):
 *
 *   allocationEffect_i = (w_p,i - w_b,i) * r_b,i
 *   selectionEffect_i  = w_p,i * (r_p,i - r_b,i)
 *
 * This is the classic three-term Brinson-Hood-Beebower model
 * (allocation + selection + interaction) with the interaction term folded into
 * selection — a documented, deliberate choice, not an omission. Folding it in
 * keeps the two-term decomposition exact for a single period:
 *
 *   allocationEffect_i + selectionEffect_i = w_p,i * r_p,i - w_b,i * r_b,i
 *
 * Summed over the full sector universe (portfolio sectors ∪ benchmark
 * sectors), the right side telescopes to R_p - R_b — the whole period's
 * portfolio-vs-benchmark excess return — with no leftover interaction term to
 * separately report or explain to a user. See tests/unit/analytics/attribution.test.ts
 * for the identity proof as a fixture test.
 *
 * ─── WEIGHT GUARDS (never NaN) ────────────────────────────────────────────────
 *
 * A sector the portfolio does not hold has w_p,i = 0. Its `portfolioReturn`
 * may be `null` (there is nothing to divide by), so `selectionEffect` is
 * guarded on `w_p,i > 0` rather than on `portfolioReturn !== null` — otherwise
 * `0 * null` would silently become `NaN` in JS instead of the correct `0`.
 *
 * ─── MULTI-PERIOD LINKING: CARIÑO SMOOTHING ──────────────────────────────────
 *
 * Period effects are additive per period but returns compound
 * multiplicatively, so naively summing daily allocation/selection effects
 * across a window does NOT reconcile to the window's actual excess return.
 * This module uses the standard Cariño (1999) logarithmic smoothing: each
 * period's effects are scaled by `k_t / K`, where `k_t` is derived from that
 * period's own portfolio/benchmark returns and `K` from the whole window's
 * compounded returns (`carinoFactor` below). This makes the identity
 *
 *   linkedAllocation + linkedSelection + linkedUnattributed = R_P - R_B
 *
 * hold exactly (mod floating-point epsilon) over the whole window — see
 * `linkPeriods` and `RECONCILIATION_TOLERANCE`.
 *
 * ─── DEGENERATE CASES: NULL/UNATTRIBUTED, NEVER Infinity ──────────────────────
 *
 * - A sector with no benchmark data for a period cannot be split into
 *   allocation/selection; its portfolio contribution (w_p,i * r_p,i) flows into
 *   that period's `unattributed` figure instead of being dropped or guessed at.
 * - A period whose compounded return implies a total wipeout (1 + R <= 0) makes
 *   `carinoFactor` return `null`. Such a period is excluded from the linked sum
 *   (see `linkPeriods`) and the resulting reconciliation gap is reported
 *   explicitly rather than fudged.
 * - Zero included periods (empty window) return a fully null/zero result —
 *   never a divide-by-zero.
 */

import { RawProtocolRatePoint, buildDailyRateSeries } from '../agent/backtest'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_YEAR = 365.25 * MS_PER_DAY

/** One day's worth of a single period, as a fraction of a year (see backtest.ts's identical convention). */
const YEAR_FRACTION_PER_DAY = MS_PER_DAY / MS_PER_YEAR

/**
 * How far a linked reconciliation may drift from zero before being flagged
 * `reconciled: false`. Cariño linking reconciles exactly in theory; this bound
 * exists purely for floating-point accumulation over many periods, not as
 * permission to silently absorb real gaps (missing periods/sectors are
 * reported through `unattributedEffect`, not this tolerance).
 */
export const RECONCILIATION_TOLERANCE = 1e-6

function toUtcDay(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY) * MS_PER_DAY
}

// ── Portfolio value series (per sector, per day) ──────────────────────────────

/** A raw snapshot row, narrowed to the columns attribution needs, plus the sector it belongs to. */
export interface PortfolioSectorRow {
  snapshotAt: Date
  /** Protocol name in v1 — see the module header. */
  sector: string
  /** principalAmount + yieldAmount. Never derived from YieldSnapshot.apy. */
  value: number
}

export interface DailyPortfolioSnapshot {
  date: Date
  /** Sector name -> value. Absent sector = not held that day, not "unknown". */
  values: Record<string, number>
}

/**
 * Collapse per-position snapshot rows into one value per (sector, UTC day),
 * taking the value from whichever row has the LATEST `snapshotAt` that day
 * (an end-of-day mark). Order-independent: rows may arrive in any order.
 *
 * Deliberately NOT forward-filled, unlike the benchmark series
 * (`buildDailyRateSeries`). Snapshots run hourly for every ACTIVE position
 * (src/agent/snapshotter.ts), so a day with no row for a still-open position is
 * not expected; a day with no row because the position closed correctly reads
 * as "not held" (value 0) rather than a stale carried-forward balance.
 */
export function buildDailyPortfolioSectorSeries(
  rows: PortfolioSectorRow[],
  startDate: Date,
  endDate: Date
): DailyPortfolioSnapshot[] {
  const startDay = toUtcDay(startDate)
  const endDay = toUtcDay(endDate)

  const valueByDay = new Map<number, Record<string, number>>()
  const latestSeenByDay = new Map<number, Record<string, number>>()

  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue
    const day = toUtcDay(r.snapshotAt)
    if (day < startDay || day > endDay) continue

    const seen = latestSeenByDay.get(day) ?? {}
    const ts = r.snapshotAt.getTime()
    if (seen[r.sector] !== undefined && seen[r.sector] >= ts) continue
    seen[r.sector] = ts
    latestSeenByDay.set(day, seen)

    const values = valueByDay.get(day) ?? {}
    values[r.sector] = r.value
    valueByDay.set(day, values)
  }

  const dayCount = Math.floor((endDay - startDay) / MS_PER_DAY) + 1
  const series: DailyPortfolioSnapshot[] = []
  for (let i = 0; i < dayCount; i++) {
    const day = startDay + i * MS_PER_DAY
    series.push({ date: new Date(day), values: valueByDay.get(day) ?? {} })
  }
  return series
}

// ── Single-period Brinson decomposition ────────────────────────────────────────

/** One sector's portfolio/benchmark state at the boundary of a period. */
export interface SectorState {
  sector: string
  /** w_p,i — 0 when the portfolio does not hold this sector. */
  portfolioWeight: number
  /** r_p,i — null when there is no starting value to compute a return from. */
  portfolioReturn: number | null
  /** w_b,i — 0 when the benchmark has no data for this sector this period. */
  benchmarkWeight: number
  /** r_b,i — null when the benchmark has no data for this sector this period. */
  benchmarkReturn: number | null
}

export interface SectorEffect {
  sector: string
  allocationEffect: number
  selectionEffect: number
}

export interface PeriodBrinsonResult {
  sectors: SectorEffect[]
  /** Sum of w_p,i * r_p,i over sectors with no benchmark comparator this period. */
  unattributed: number
  /** R_p,t = sum_i w_p,i * r_p,i (the period's whole-portfolio return, Brinson-native). */
  portfolioReturn: number
  /** R_b,t = sum_i w_b,i * r_b,i (the period's whole-benchmark return). */
  benchmarkReturn: number
}

/**
 * Decompose one period's sector states into allocation/selection effects.
 *
 * `portfolioReturn`/`benchmarkReturn` on the result are DERIVED from the same
 * weight*return sums the effects are built from (not an independent
 * start/end-value ratio) — this is what makes a period where the portfolio
 * started empty (all w_p,i = 0) contribute exactly 0 portfolio return and 0
 * selection effect, without a separate "skip this period" branch: a deposit
 * into an empty portfolio is not a return, and the sector-native definition
 * makes that fall out for free rather than needing a special case (contrast
 * with the explicit <=0-start-value skip in strategyMetrics.periodReturns,
 * which this generalizes for the multi-sector case).
 */
export function brinsonPeriod(
  sectorStates: SectorState[]
): PeriodBrinsonResult {
  const sectors: SectorEffect[] = []
  let unattributed = 0
  let portfolioReturn = 0
  let benchmarkReturn = 0

  for (const s of sectorStates) {
    if (s.portfolioWeight > 0 && s.portfolioReturn !== null) {
      portfolioReturn += s.portfolioWeight * s.portfolioReturn
    }
    if (s.benchmarkWeight > 0 && s.benchmarkReturn !== null) {
      benchmarkReturn += s.benchmarkWeight * s.benchmarkReturn
    }

    const hasBenchmark = s.benchmarkWeight > 0 && s.benchmarkReturn !== null
    if (!hasBenchmark) {
      // No comparator this period: cannot split into allocation/selection.
      // Flows into `unattributed` rather than being dropped or guessed at.
      if (s.portfolioWeight > 0 && s.portfolioReturn !== null) {
        unattributed += s.portfolioWeight * s.portfolioReturn
      }
      continue
    }

    const rb = s.benchmarkReturn as number
    const allocationEffect = (s.portfolioWeight - s.benchmarkWeight) * rb
    // Guarded on portfolioWeight, not on portfolioReturn !== null: a sector the
    // portfolio does not hold has weight 0 and no selection story even when
    // portfolioReturn happens to be null — `0 * null` must not become NaN.
    const selectionEffect =
      s.portfolioWeight > 0 && s.portfolioReturn !== null
        ? s.portfolioWeight * (s.portfolioReturn - rb)
        : 0

    sectors.push({ sector: s.sector, allocationEffect, selectionEffect })
  }

  return { sectors, unattributed, portfolioReturn, benchmarkReturn }
}

// ── Multi-period Cariño linking ─────────────────────────────────────────────────

/**
 * Cariño (1999) logarithmic smoothing coefficient for one interval with
 * portfolio/benchmark returns (rp, rb):
 *
 *   k = (ln(1+rp) - ln(1+rb)) / (rp - rb),  rp != rb
 *   k = 1 / (1+rp),                          rp == rb (removable-singularity limit)
 *
 * Returns null when 1+rp <= 0 or 1+rb <= 0 — a total-wipeout return makes the
 * logarithm undefined. Callers must treat null as "cannot link this interval",
 * never coerce it to 0 or Infinity.
 */
export function carinoFactor(
  portfolioReturn: number,
  benchmarkReturn: number
): number | null {
  const p1 = 1 + portfolioReturn
  const b1 = 1 + benchmarkReturn
  if (!(p1 > 0) || !(b1 > 0)) return null

  if (Math.abs(portfolioReturn - benchmarkReturn) < 1e-12) {
    return 1 / p1
  }
  return (Math.log(p1) - Math.log(b1)) / (portfolioReturn - benchmarkReturn)
}

/** One period's Brinson decomposition, ready to be linked across the window. */
export interface LinkedPeriodInput {
  portfolioReturn: number
  benchmarkReturn: number
  sectors: SectorEffect[]
  unattributed: number
}

export interface SectorLinkedEffect {
  allocationEffect: number
  selectionEffect: number
}

export interface LinkedAttribution {
  /** Compounded portfolio return over every included period. */
  portfolioReturn: number
  /** Compounded benchmark return over every included period. */
  benchmarkReturn: number
  allocationEffect: number
  selectionEffect: number
  unattributedEffect: number
  /** (portfolioReturn - benchmarkReturn) - (allocation + selection + unattributed). */
  reconciliationGap: number
  reconciled: boolean
  sectorEffects: Map<string, SectorLinkedEffect>
}

/**
 * Link a sequence of daily Brinson decompositions into one window-level
 * result using Cariño smoothing. Returns null only for an empty input — every
 * other degenerate case (a wipeout period, a wipeout total) is reported as an
 * explicit `reconciliationGap` with `reconciled: false`, never as NaN/Infinity
 * and never silently fudged to force a match.
 */
export function linkPeriods(
  periods: LinkedPeriodInput[]
): LinkedAttribution | null {
  if (periods.length === 0) return null

  let compoundedP = 1
  let compoundedB = 1
  for (const p of periods) {
    compoundedP *= 1 + p.portfolioReturn
    compoundedB *= 1 + p.benchmarkReturn
  }
  const totalP = compoundedP - 1
  const totalB = compoundedB - 1

  const K = carinoFactor(totalP, totalB)
  if (K === null || K === 0) {
    // Whole-window wipeout (K undefined) or an exactly-zero scaling factor:
    // never divide. Report the raw excess return as unreconciled rather than
    // fabricating a linked split for it.
    return {
      portfolioReturn: totalP,
      benchmarkReturn: totalB,
      allocationEffect: 0,
      selectionEffect: 0,
      unattributedEffect: 0,
      reconciliationGap: totalP - totalB,
      reconciled: totalP === totalB,
      sectorEffects: new Map(),
    }
  }

  let allocationEffect = 0
  let selectionEffect = 0
  let unattributedEffect = 0
  const sectorEffects = new Map<string, SectorLinkedEffect>()

  for (const p of periods) {
    const k = carinoFactor(p.portfolioReturn, p.benchmarkReturn)
    // A single-period wipeout is excluded from the linked sum; its
    // contribution surfaces honestly as part of the final reconciliationGap.
    if (k === null) continue
    const scale = k / K

    for (const s of p.sectors) {
      allocationEffect += scale * s.allocationEffect
      selectionEffect += scale * s.selectionEffect
      const entry = sectorEffects.get(s.sector) ?? {
        allocationEffect: 0,
        selectionEffect: 0,
      }
      entry.allocationEffect += scale * s.allocationEffect
      entry.selectionEffect += scale * s.selectionEffect
      sectorEffects.set(s.sector, entry)
    }
    unattributedEffect += scale * p.unattributed
  }

  const reconciliationGap =
    totalP - totalB - (allocationEffect + selectionEffect + unattributedEffect)

  return {
    portfolioReturn: totalP,
    benchmarkReturn: totalB,
    allocationEffect,
    selectionEffect,
    unattributedEffect,
    reconciliationGap,
    reconciled: Math.abs(reconciliationGap) <= RECONCILIATION_TOLERANCE,
    sectorEffects,
  }
}

// ── Top-level: build periods from raw rows and link them ───────────────────────

export interface SectorAttribution {
  sector: string
  /** Time-averaged portfolio weight across the window (0-1). */
  portfolioWeight: number
  /** Time-averaged benchmark weight across the window (0-1). */
  benchmarkWeight: number
  /** Compounded sector return over periods it was held; null if never held with a computable return. */
  portfolioReturn: number | null
  /** Compounded benchmark-sector return over periods it had data; null if it never had data. */
  benchmarkReturn: number | null
  /** Linked allocation effect for this sector, in the same units as the window totals. */
  allocationEffect: number
  /** Linked selection effect for this sector. */
  selectionEffect: number
}

export interface AttributionResult {
  windowDays: number
  /** Number of daily periods in the window (windowDays). */
  periodCount: number
  /** Periods that had at least one benchmark sector with data (see below). */
  includedPeriodCount: number
  portfolioReturn: number
  benchmarkReturn: number
  allocationEffect: number
  selectionEffect: number
  unattributedEffect: number
  reconciliationGap: number
  reconciled: boolean
  sectors: SectorAttribution[]
  benchmarkVersion: string
}

/** A degenerate, all-zero result for a window with nothing to attribute. */
function emptyResult(
  windowDays: number,
  benchmarkVersion: string
): AttributionResult {
  return {
    windowDays,
    periodCount: windowDays,
    includedPeriodCount: 0,
    portfolioReturn: 0,
    benchmarkReturn: 0,
    allocationEffect: 0,
    selectionEffect: 0,
    unattributedEffect: 0,
    reconciliationGap: 0,
    reconciled: true,
    sectors: [],
    benchmarkVersion,
  }
}

export interface AttributionInput {
  /** Raw per-position value rows, any order (job supplies YieldSnapshot joined to Position.protocolName). */
  portfolioRows: PortfolioSectorRow[]
  /**
   * Raw, possibly gappy protocol rate observations forming the benchmark
   * universe — already filtered to the configured protocol subset, or every
   * protocol if unrestricted. Reused verbatim by `buildDailyRateSeries`, so
   * the benchmark inherits its documented hold-last-known forward-fill.
   */
  benchmarkRates: RawProtocolRatePoint[]
  /** 30 or 90 — see docs/STRATEGY_MARKETPLACE.md's retention-honesty rule; this module does not enforce the enum itself. */
  windowDays: number
  /** Reference "now", injected for deterministic tests. */
  now?: Date
  /** Label for which benchmark definition/protocol subset produced `benchmarkRates`, echoed onto the result for the report to name. */
  benchmarkVersion: string
}

/**
 * Compute a full window's attribution from raw rows. Builds a daily portfolio
 * value series and a daily benchmark rate series, decomposes each day into a
 * Brinson period, links them with Cariño smoothing, and rolls up per-sector
 * time-averaged weights and compounded returns for the report.
 */
export function computeAttribution(input: AttributionInput): AttributionResult {
  const now = input.now ?? new Date()
  const endDate = new Date(toUtcDay(now))
  const startDate = new Date(endDate.getTime() - input.windowDays * MS_PER_DAY)

  const portfolioSeries = buildDailyPortfolioSectorSeries(
    input.portfolioRows,
    startDate,
    endDate
  )
  const { series: benchmarkSeries } = buildDailyRateSeries(
    input.benchmarkRates,
    startDate,
    endDate
  )

  if (portfolioSeries.length < 2 || benchmarkSeries.length < 2) {
    return emptyResult(input.windowDays, input.benchmarkVersion)
  }

  const linkedInputs: LinkedPeriodInput[] = []

  // Per-sector rollups, accumulated alongside the periods.
  const weightSum = new Map<string, { p: number; b: number }>()
  const compoundedPortfolio = new Map<
    string,
    { product: number; everHeld: boolean }
  >()
  const compoundedBenchmark = new Map<
    string,
    { product: number; everSeen: boolean }
  >()

  for (let t = 1; t < portfolioSeries.length; t++) {
    const prevValues = portfolioSeries[t - 1].values
    const currValues = portfolioSeries[t].values
    const benchmarkDay = benchmarkSeries[t - 1] // rate quoted at the START of the period

    const totalPortfolioStart = Object.values(prevValues).reduce(
      (s, v) => s + v,
      0
    )
    const benchmarkSectorCount = benchmarkDay.protocols.length
    // No benchmark data at all this day: nothing to compare against. Skip the
    // whole period rather than fabricating a 0% market return.
    if (benchmarkSectorCount === 0) continue

    const benchmarkWeight = 1 / benchmarkSectorCount
    const sectorNames = new Set<string>([
      ...Object.keys(prevValues),
      ...benchmarkDay.protocols.map((p) => p.name),
    ])

    const sectorStates: SectorState[] = []
    for (const sector of sectorNames) {
      const startValue = prevValues[sector] ?? 0
      const endValue = currValues[sector] ?? 0
      const portfolioWeight =
        totalPortfolioStart > 0 ? startValue / totalPortfolioStart : 0
      const portfolioReturn =
        startValue > 0 ? (endValue - startValue) / startValue : null

      const benchmarkProtocol = benchmarkDay.protocols.find(
        (p) => p.name === sector
      )
      const hasBenchmark = benchmarkProtocol !== undefined
      const benchmarkReturn = hasBenchmark
        ? (benchmarkProtocol.apy / 100) * YEAR_FRACTION_PER_DAY
        : null

      sectorStates.push({
        sector,
        portfolioWeight,
        portfolioReturn,
        benchmarkWeight: hasBenchmark ? benchmarkWeight : 0,
        benchmarkReturn,
      })

      const w = weightSum.get(sector) ?? { p: 0, b: 0 }
      w.p += portfolioWeight
      w.b += hasBenchmark ? benchmarkWeight : 0
      weightSum.set(sector, w)

      if (portfolioWeight > 0 && portfolioReturn !== null) {
        const c = compoundedPortfolio.get(sector) ?? {
          product: 1,
          everHeld: false,
        }
        c.product *= 1 + portfolioReturn
        c.everHeld = true
        compoundedPortfolio.set(sector, c)
      }
      if (hasBenchmark && benchmarkReturn !== null) {
        const c = compoundedBenchmark.get(sector) ?? {
          product: 1,
          everSeen: false,
        }
        c.product *= 1 + benchmarkReturn
        c.everSeen = true
        compoundedBenchmark.set(sector, c)
      }
    }

    const period = brinsonPeriod(sectorStates)
    linkedInputs.push({
      portfolioReturn: period.portfolioReturn,
      benchmarkReturn: period.benchmarkReturn,
      sectors: period.sectors,
      unattributed: period.unattributed,
    })
  }

  const linked = linkPeriods(linkedInputs)
  if (!linked) return emptyResult(input.windowDays, input.benchmarkVersion)

  const includedPeriodCount = linkedInputs.length
  const sectors: SectorAttribution[] = Array.from(weightSum.keys())
    .sort()
    .map((sector) => {
      const w = weightSum.get(sector) as { p: number; b: number }
      const effect = linked.sectorEffects.get(sector) ?? {
        allocationEffect: 0,
        selectionEffect: 0,
      }
      const p = compoundedPortfolio.get(sector)
      const b = compoundedBenchmark.get(sector)
      return {
        sector,
        portfolioWeight: w.p / includedPeriodCount,
        benchmarkWeight: w.b / includedPeriodCount,
        portfolioReturn: p?.everHeld ? p.product - 1 : null,
        benchmarkReturn: b?.everSeen ? b.product - 1 : null,
        allocationEffect: effect.allocationEffect,
        selectionEffect: effect.selectionEffect,
      }
    })

  return {
    windowDays: input.windowDays,
    periodCount: input.windowDays,
    includedPeriodCount,
    portfolioReturn: linked.portfolioReturn,
    benchmarkReturn: linked.benchmarkReturn,
    allocationEffect: linked.allocationEffect,
    selectionEffect: linked.selectionEffect,
    unattributedEffect: linked.unattributedEffect,
    reconciliationGap: linked.reconciliationGap,
    reconciled: linked.reconciled,
    sectors,
    benchmarkVersion: input.benchmarkVersion,
  }
}
