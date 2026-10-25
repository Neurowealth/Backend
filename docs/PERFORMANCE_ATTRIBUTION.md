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

No real market index exists yet. v1 defines "the market" as the average of
available `ProtocolRate` APY history — every protocol with a rate quote on a
given day counts as a member of the benchmark that day (or a configured subset
via `ATTRIBUTION_BENCHMARK_PROTOCOLS`).

**One definition, one place.** The market is defined exactly once, in
`src/analytics/benchmark.ts` (`buildMarketFactorSeries`), defaulting to
**equal-weighted** with a pluggable **TVL-weighted** alternative that falls
back to equal when no TVL data is available. `attribution.ts` imports this
canonical series rather than re-deriving the market (Flaunch #352); a golden
test pins attribution's output so a benchmark change can never silently alter
an attribution number. A real index feed can be dropped in later by supplying
a differently-sourced series in the same shape.

`benchmarkVersion` on every persisted attribution row names which
definition/subset produced it, so a later config change never silently
reinterprets an old row.

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

## 5. Rolling beta & market-factor exposure (#352)

Attribution answers *why* a portfolio out/under-performed. Factor exposure
answers a different question: **how much of a portfolio's yield movement is
explained by the DeFi-yield "market factor" versus idiosyncratic protocol
selection**, and — because it is computed on a rolling window — **how that
exposure is changing over time** rather than as a single point estimate.

The market factor is the canonical series from `src/analytics/benchmark.ts`.
A **yield co-movement beta** is computed by OLS of the portfolio's daily value
return on the market's daily return. A beta of ~1 means "your yield moves with
the tracked-protocol market"; ~0 means "independent of it".

### The pure core

`src/analytics/factorExposure.ts` — zero I/O, fixture-tested:

- `rollingBeta(portfolioReturns, marketReturns, windowSize, step)` returns one
  `{ windowEndMs, beta, alpha, rSquared, sampleCount }` per window; windows
  under `MIN_FACTOR_SAMPLES` (14) or with effectively-zero market variance
  return **null** statistics — never NaN, never a fabricated 0.
- `factorDecomposition(...)` runs one OLS over the full window →
  `{ beta, alpha(annualized), rSquared, idiosyncraticVolShare }`, where
  `idiosyncraticVolShare = 1 − R²` is "how much of your yield variance is your
  protocol selection".

### DB glue + alignment

`src/analytics/factorExposureService.ts` reads the user's `YieldSnapshot`
value buckets (`principal + yield`, never `apy`) and the benchmark universe's
`ProtocolRate` history, builds both daily series on the **same UTC-day grid**,
and keeps **only days present on both sides** — mismatched days are dropped,
never zero-filled; `sampleCount` is the intersection (`MIN_FACTOR_SAMPLES` of
these are required before beta means anything).

### API

`GET /api/v1/analytics/factor-exposure?window=90d&rollingWindow=30d`
(both optional; `window ∈ {30d,60d,90d}`, `rollingWindow ∈ {7d,14d,30d}`,
`weighting ∈ {equal,tvl}`) — authenticated, owner-scoped via
`req.auth.userId`. Returns `{ rolling, summary, benchmark, insufficientHistory,
sampleCount, caveats, inputHash, computedAt }`.

- Retention is bounded at 90 days; `rollingWindow` must be **shorter than**
  `window` (400 otherwise), because YieldSnapshots are hard-deleted past 90
  days.
- A `rollingWindow` that leaves fewer than 2 windows returns the **summary
  only**, with a caveat.
- Every response ships `FACTOR_CAVEAT`: *"The 'market' is the equal-weighted
  average of tracked protocol APY series, not a traded index. Beta here
  measures yield co-movement, not price beta."*
- Deterministic: protocols sorted, `asOf` explicit, and an `inputHash`
  (sha256 over the sorted portfolio-value + benchmark-rate snapshot) returned
  so the report can be reproduced.

---

## 6. Out of scope (deliberately)

1. A live external benchmark index feed — the module accepts an exogenous
   `RawProtocolRatePoint[]` series; sourcing a real index is deferred.
2. Transaction-cost attribution (cost drag within selection).
3. Currency-hedging attribution.
4. A protocol-to-sector grouping map (v1 sector = protocol).
