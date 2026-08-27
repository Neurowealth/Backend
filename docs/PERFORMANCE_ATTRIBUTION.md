# Performance Attribution & Benchmark-Relative Return Reporting (#320)

Answers "why" a portfolio (or a published strategy) returned what it did: a
Brinson-style, benchmark-relative decomposition into an **allocation
effect** (did the money sit in the right protocols?) and a **selection
effect** (did the chosen protocol beat its peers?), linked across a 30- or
90-day window. Same pure-math-plus-persisted-job architecture as
[STRATEGY_MARKETPLACE.md](./STRATEGY_MARKETPLACE.md).

---

## 1. The pure core

Lives in `src/analytics/attribution.ts` — zero I/O, unit tested against
fixture series. `src/jobs/attribution.ts` is the only thing that reads the DB
and calls into it.

### The same correctness trap as strategyMetrics.ts

`YieldSnapshot.apy` is a cumulative running average, never a period return
(see STRATEGY_MARKETPLACE.md §2). Attribution is computed from portfolio
**value** (`principalAmount + yieldAmount`), bucketed per protocol per day —
never from the raw `apy` column. `ProtocolRate.supplyApy` **is** a rate quote
and is the correct input for the benchmark side, matching
`src/analytics/estimation.ts`.

### The benchmark, v1

No real market index exists yet. v1 defines "the market" as the
**equal-weighted average of available `ProtocolRate` APY history** — every
protocol with a rate quote on a given day counts as one equally-weighted
sector of the benchmark that day (or a configured subset via
`ATTRIBUTION_BENCHMARK_PROTOCOLS`). The pure module never reads
`ProtocolRate` itself: it accepts `RawProtocolRatePoint[]` (the same type
`src/agent/backtest.ts` defines for the backtest engine), so a real index feed
can be dropped in later by supplying a differently-sourced series in the same
shape. `benchmarkVersion` on every persisted row names which definition/subset
produced it, so a later config change never silently reinterprets an old row.

### Sectors, v1

A "sector" is a protocol name. A protocol-to-sector map (grouping several
protocols into one sector, e.g. "lending" vs. "DEX LP") is a natural v2
extension, deliberately out of scope here.

### The Brinson model, interaction folded into selection

For sector _i_ in period _t_, with portfolio weight/return `(w_p, r_p)` and
benchmark weight/return `(w_b, r_b)`:

```
allocationEffect_i = (w_p,i - w_b,i) * r_b,i
selectionEffect_i  = w_p,i * (r_p,i - r_b,i)
```

This is the classic three-term Brinson-Hood-Beebower model with the
interaction term folded into selection — a documented, deliberate choice.
Folding it in keeps the decomposition exact for a single period:

```
allocationEffect_i + selectionEffect_i = w_p,i * r_p,i - w_b,i * r_b,i
```

Summed over the full sector universe, the right side telescopes to `R_p - R_b`
— the whole period's excess return — with no separate interaction term to
explain to a user.

**Weight guards, never NaN**: a sector the portfolio does not hold has
`w_p,i = 0`. Its `portfolioReturn` may be `null` (nothing to divide by), so
`selectionEffect` is guarded on `w_p,i > 0` rather than on
`portfolioReturn !== null` — `0 * null` would otherwise become `NaN` in JS
instead of the correct `0`.

**An empty-to-funded period** (portfolio started with nothing) is handled by
construction rather than a special "skip" branch: with `w_p,i = 0` for every
sector, the period's whole-portfolio return is exactly `0` (a deposit into an
empty portfolio is not a return), while the benchmark side still credits a
pure allocation effect for whatever the market did during the gap — see the
"empty-to-funded" fixture test.

### Multi-period linking: Cariño smoothing

Period effects are additive per period but returns compound multiplicatively,
so naively summing daily effects across a window does not reconcile to the
window's actual excess return. This module uses the standard
**Cariño (1999) logarithmic smoothing**: each period's effects are scaled by
`k_t / K`, where `k_t` derives from that period's own returns and `K` from the
whole window's compounded returns. This makes

```
linkedAllocation + linkedSelection + linkedUnattributed = R_P - R_B
```

hold exactly (mod floating-point epsilon) over the whole window. Periods run
on a **daily** grid (matching `buildDailyRateSeries`'s existing gap policy),
not the hourly cadence snapshots are captured at.

### Degenerate cases: null/unattributed, never Infinity

- A sector with no benchmark data for a period cannot be split into
  allocation/selection; its portfolio contribution flows into that period's
  `unattributed` figure instead of being dropped or guessed at.
- A period whose compounded return implies a total wipeout (`1 + R <= 0`)
  excludes that period from the linked sum; the resulting gap is reported
  explicitly (`reconciliationGap`, `reconciled: false`) rather than fudged.
- Zero included periods return a fully null/zero result — never a
  divide-by-zero.

`RECONCILIATION_TOLERANCE` (`1e-6`) bounds only floating-point accumulation
over many periods — it is not permission to silently absorb real gaps from
missing data, which flow through `unattributedEffect` instead.

---

## 2. Precomputation + persistence

`src/jobs/attribution.ts` fetches the whole window's `YieldSnapshot` and
`ProtocolRate` history **once per run** (not once per user), computes
attribution per user and per published strategy, and upserts into:

- `PortfolioAttribution` — one row per `(userId, windowDays)`.
- `StrategyAttribution` — one row per `(publishedStrategyId, windowDays)`,
  computed for every `PublishedStrategy` regardless of `isPublished` (so
  re-publishing shows a benchmark-relative figure immediately, mirroring
  `PublishedStrategyMetric`).

Windows are **30d and 90d only** — `YieldSnapshot` retention is 90 days
(`src/agent/snapshotter.ts`), so a longer window has no data behind it.

`scripts/backfill-attribution.ts` recomputes on demand: a fresh deploy of the
migration (no rows exist yet), a benchmark-config change, or a manual repair.
Idempotent — every write is an upsert keyed on `(subject, windowDays)`.

### Configuration

| Env var                          | Default | Meaning                                                              |
| --------------------------------- | ------- | ---------------------------------------------------------------------|
| `ATTRIBUTION_INTERVAL_MS`         | `21600000` (6h) | Recompute cadence, matching `strategyMarketplace`.           |
| `ATTRIBUTION_BENCHMARK_PROTOCOLS` | unset (= every protocol) | Comma-separated protocol-name subset for the benchmark. |

---

## 3. API

`GET /api/v1/analytics/attribution?window=30d\|90d` — authenticated,
owner-scoped via `req.auth.userId` (never a path param). Reads the persisted
`PortfolioAttribution` row; returns `{ computed: false }` (still a 200, not a
404) when nothing has been precomputed yet — a normal state for a new
account, mirroring the `{ follow: null }` convention in the strategy
marketplace.

The strategy marketplace (`GET /api/v1/strategies/marketplace`) gains
`vsBenchmark` on each entry: `portfolioReturn - benchmarkReturn` from
`StrategyAttribution`, merged onto the page of `PublishedStrategyMetric` rows
by strategy id — a bounded lookup over the current page only, **not** a
second sort key and **not** a per-request recompute. `null` when attribution
has not been computed yet for that strategy/window.

Both responses report only relative figures (returns, weights, effects) —
never an absolute currency amount — and a strategy's report is derived from
the publisher's own aggregates only, matching the anonymization boundary in
STRATEGY_MARKETPLACE.md §1.

---

## 4. Consistency

`tests/unit/analytics/attribution.test.ts` includes an anti-divergence test:
the whole-portfolio value produced by attribution's per-sector series must
equal `strategyMetrics.bucketByInstant`'s output for the same rows at the
same instant. If the two ever diverge, that test fails — attribution and the
marketplace's Sharpe/APY figures must always agree on what "portfolio value"
means.

---

## 5. Out of scope (deliberately)

1. A live external benchmark index feed — the module accepts an exogenous
   `RawProtocolRatePoint[]` series; sourcing a real index is deferred.
2. Transaction-cost attribution (cost drag within selection).
3. Currency-hedging attribution.
4. A protocol-to-sector grouping map (v1 sector = protocol).
