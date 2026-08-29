# Portfolio Correlation & Diversification (#348)

An analytics endpoint that answers "how synchronized are my protocols' yield
curves, and how diversified is that?" — `GET /api/v1/analytics/correlation`.

## What it computes

- A **Pearson correlation matrix** over protocols, from the same aligned daily
  rate levels the optimizer's covariance comes from (`ProtocolRate.supplyApy`,
  via `aggregateDailyRates` + `buildDailyRateSeries`). Same alignment machinery
  as `estimation.ts`, so a correlation and a covariance can never disagree about
  which days they observe.
- An **average pairwise correlation**, optionally weighted by the user's current
  portfolio (`position.currentValue` weights).
- A **diversification score** 0–100: `clamp((1 − avgCorrelation) × 100, 0, 100)`.
  Higher = more diversified (lower average correlation). The clamp matters: a
  net-negative average correlation would otherwise exceed 100.

## Semantics that are enforced, not implied

- Correlation measures **yield-quote co-movement**, not price correlation, and
  says nothing about principal loss, depeg, or smart-contract failure. The
  `caveat` travels with every response (`CORRELATION_CAVEAT`).
- **Null-on-degenerate, never 0/1.** A constant series has no defined
  correlation, so a pair with zero variance on either side is `null` — 0 would
  falsely claim "uncorrelated". The diversification score is `null` when fewer
  than 2 protocols have history, never 0.
- **Computed vs not.** When fewer than 2 protocols have history in the window,
  the endpoint returns `computed: false` with the empty matrix and the
  exclusions (fail-closed, with machine-readable reasons) rather than a
  plausible-looking matrix.

## Code layout

- Pure core: `src/analytics/correlation.ts` — `computeCorrelationMatrix`,
  `averagePairwiseCorrelation`, `diversificationScore`, `estimateCorrelation`.
  Zero I/O, unit-tested.
- DB glue: `src/analytics/correlationService.ts` — reads `ProtocolRate` history
  and the user's `position` weights, calls the pure core.
- Route: `src/routes/analytics.ts` → `GET /analytics/correlation` (window
  `30d`/`60d`/`90d`, JWT-authenticated).

## Window retention

Correlation uses the last `window` days of `ProtocolRate` history. Longer
windows are unavailable because yield snapshots are only retained for 90 days;
the endpoint's maximum `window` is therefore `90d`.
