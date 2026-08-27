# Strategy Marketplace / Opt-In Copy-Trading (#285)

A user publishes an anonymized snapshot of their agent **configuration**, others
follow it, and a follower's agent applies that configuration on its next
scheduled run.

**Configuration only — never funds, never custody, never keys.**

---

## 1. The two boundaries

These are the load-bearing properties of the feature. Both are enforced
structurally, not by convention, and both have tests that fail if the structure
changes.

### Custody boundary

A follow copies configuration and nothing else. `src/strategy/service.ts`
imports nothing from `src/stellar/` — no wallet, no contract, no key custody — so
there is **no code path from a follow to another user's funds**.

Asserted by `tests/integration/agent/strategy-follow.integration.test.ts`, which
reads the import graph of `src/strategy/service.ts` and
`src/agent/effectiveStrategy.ts` and fails if a
stellar/wallet/db import appears. The same suite drives a real
`rebalanceCheckJob` with a follow in place and asserts that no wallet is opened,
no key is read, `db.custodialWallet` is never touched, and no downstream call
carries the publisher's user id.

### Anonymization boundary

Three independent layers, because this is the first feature exposing one user's
data to another:

| Layer     | Where                                                                                    | What it does                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Query  | `marketplaceSelect` in `src/strategy/service.ts`                                         | Never selects `userId`, never includes `user`. Follows the `alertSelect` pattern in `src/routes/alerts.ts`.                                   |
| 2. Mapper | `mapMarketplaceEntryToResponse` / `mapFollowToResponse` in `src/utils/api-formatters.ts` | Hand-written allowlists, never a spread. Adding a field to a select does not silently publish it.                                             |
| 3. Input  | `strategyLabelSchema` in `src/validators/strategy-validators.ts`                         | `label` is the one place a user can self-doxx. Rejects Stellar addresses (`[GC]` + 55 base32 chars) and 32+ char hex runs; caps length at 60. |

The publisher's `userId` **is** loaded in `followStrategy` — solely to compare
against the caller for the self-follow check. It never reaches a response.

Displayed statistics are derived from the publisher's own aggregates only. The
response carries `apy` / `sharpe` / `trackRecordDays` / `sampleCount` /
`vsBenchmark` and never an absolute currency amount. `vsBenchmark` (#320) is a
relative figure — the strategy's portfolio return minus the benchmark's return
over the window — sourced from `StrategyAttribution`; see
docs/PERFORMANCE_ATTRIBUTION.md.

---

## 2. The metric definition

Lives in `src/agent/strategyMetrics.ts` — pure, zero I/O, unit tested against
fixture series. `src/jobs/strategyMetrics.ts` is the only thing that reads the DB
and calls into it.

### The correctness trap

`YieldSnapshot.apy` is **not** a period return. `src/agent/snapshotter.ts`
computes it as cumulative-yield-since-`openedAt`, annualized — so consecutive
values are a smoothed running average. Taking the standard deviation of that
column would badly understate volatility and produce a flattering, easily gamed
Sharpe ratio.

The correct series is portfolio **value**:

1. `value = principalAmount + yieldAmount`, summed across positions sharing an
   exact `snapshotAt` so a point is the whole portfolio, not one position
   (`bucketByInstant`; same aggregation as `valueByInstant` in
   `src/jobs/alertRules.ts`).
2. Differenced into simple period returns (`periodReturns`). An interval whose
   starting value is `<= 0` is **skipped** — a portfolio funded from empty is a
   deposit, not a return, and letting it through would hand the publisher an
   unbounded Sharpe.

### Formulas

**Annualized return** (`annualizedReturnPercent`) — simple, non-compounding,
matching `snapshotter.calculateApy` and `src/goals/service.ts` so marketplace
figures never disagree with the APY shown elsewhere in the product:

```
totalReturn = (lastValue - firstValue) / firstValue
years       = max(elapsed / 365.25 days, 1/365)
apy         = totalReturn / years * 100
```

**Sharpe ratio** (`sharpeRatio`):

```
perPeriodRiskFree = riskFreeRate / periodsPerYear
sharpe            = (mean(returns) - perPeriodRiskFree) / sampleStdev(returns)
                    * sqrt(periodsPerYear)
```

- `sampleStdev` is the **sample** standard deviation (n-1), the standard Sharpe
  denominator.
- `periodsPerYear` is inferred from the **median** spacing of the series
  (`inferPeriodsPerYear`), so a single data gap does not distort the
  annualization factor. Snapshots are hourly, so this is ~8766 in practice.
- `riskFreeRate` defaults to **0**, configurable via
  `STRATEGY_RISK_FREE_RATE`. Stating it explicitly beats a hidden non-zero
  assumption.

**Sharpe is `null` — never 0, never a sentinel — when it is not computable**:
fewer than two returns, or a zero/degenerate standard deviation. A flat series
has no risk-adjusted story to tell, and dividing by its zero stdev would produce
`Infinity`, which would sort straight to the top of the leaderboard.

### Eligibility gate (anti-gaming)

```
trackRecordDays >= 30   (MIN_TRACK_RECORD_DAYS)
sampleCount     >= 14   (MIN_SAMPLES)
sharpe          !== null
```

Ineligible strategies are **excluded from the leaderboard entirely** rather than
shown with a low score, so a one-day strategy posting a misleading APY never
appears. Mirrors the `insufficientHistory` handling in
`src/agent/riskScoring.ts`.

`trackRecordDays` is measured from the publisher's **earliest ever** snapshot,
supplied separately from the windowed series. This is deliberate: the window
governs the _return statistics_, the track record governs _trust_. Conflating
them would make the 30-day window structurally incapable of ever reaching a
30-day track record — its oldest in-window sample sits ~30 days back, floors to
29, and the 30-day leaderboard would stay permanently empty.

### Windows: 30d and 90d only

`src/agent/snapshotter.ts` hard-deletes `YieldSnapshot` rows past 90 days. A `1y`
window therefore has no data behind it and would return a 90-day figure
mislabelled as a year. It is rejected with a **400 naming the retention limit**,
never silently downgraded.

### This is the #225 seam

Issue #225 (portfolio analytics: Sharpe / Sortino / volatility) has not landed —
there is no analytics service in `src/`. `src/agent/strategyMetrics.ts` is the
**one** definition of risk-adjusted return in this codebase. When #225 lands,
re-point this module at that service. **Do not add a third definition.**

---

## 3. Precedence

Highest first, when the agent picks a strategy for a user:

1. **Active `SavingsGoal`** — a stated personal target outranks a copied
   configuration. Handled in `src/agent/router.ts`, unchanged by this feature.
2. **Followed strategy** — the follow's `appliedConfig` snapshot.
3. **The user's own** `User.rebalanceStrategy` / `User.strategyConfig`.

Merging happens in `resolveEffectiveConfig` (`src/agent/effectiveStrategy.ts`).
A follow replaces the strategy and its allocations **wholesale**, not
key-by-key — pairing the publisher's strategy with the follower's leftover
allocations would produce a configuration neither party chose.

### The risk-ceiling invariant

`riskCeiling` is the one key a follow may **not** simply overwrite. Higher score
= lower risk, so the stricter ceiling is the **larger** number, and that is what
wins (`Math.max`).

> **A follow can only ever tighten a follower's risk exposure, never widen it.**

Copying a stranger's looser ceiling onto someone's funds because they clicked
"follow" is not a trade-off this feature is allowed to make. Mirrors the
fail-closed contract in `applyRiskCeiling` (`src/agent/strategies.ts`).

`riskTolerance` is never copied at all — it stays personal to each user.

---

## 4. Agent-loop integration

Two hazards in `src/agent/loop.ts`, both of which would silently corrupt
behavior:

**Hazard 1 — batching collision.** `src/agent/router.ts` reads only
`userStrategyPreferences[0]`. The batching key was `${protocolName}:${strategy}`,
so two followers of _different_ published strategies sharing a protocol would
collapse into one batch and both receive index-0's config, including index-0's
risk ceiling. The key is now:

```
`${protocolName}:${effectiveStrategyName}:${followId ?? 'none'}`
```

Keyed on the per-user **follow id**, not the followed strategy id: two followers
of the _same_ strategy can still have different effective ceilings, because a
follow clamps to the stricter of publisher and follower. It costs some batching;
it buys risk correctness.

**Hazard 2 — the preferences guard.** `src/agent/loop.ts` built `userStrategyPreferences`
only when `strategyName` was truthy; otherwise it passed `undefined` and
`executeRebalanceIfNeeded` skipped the strategy engine entirely. A follower whose
own `rebalanceStrategy` is null — the common case for a new user, and exactly who
this feature targets — would have had their followed config silently ignored.
The guard is now "an effective strategy **or** an active follow".

### Backward-compatibility contract

A user with no follow takes an identical code path, issues identical queries, and
produces identical decisions. Their own config is read with the exact same raw
expressions as before #285 (uncoerced), and the follow component of the batching
key is the constant `'none'`, so grouping is unchanged. Asserted by the
no-follow regression tests in
`tests/integration/agent/strategy-follow.integration.test.ts`.

The follow lookup is **one query per tick** (`loadActiveFollowsForUsers`), not
one per user, and returns an empty Map when nobody in the batch follows anything.

`followedStrategyId` is threaded into the `AgentLog` row for auditability only —
it never influences a decision.

---

## 5. Data model

| Model                     | Notes                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PublishedStrategy`       | One row per user (`userId @unique`) — publish always acts on the caller, so re-publishing upserts. `configVersion` bumps only on a **material** change to the three agent-relevant keys; a label edit is cosmetic.                                                                                                        |
| `StrategyFollow`          | Carries its own `appliedConfig` **snapshot**, not a live read-through. `publishedStrategyId` is nullable with `onDelete: SetNull` so a follower survives the publisher deleting their account.                                                                                                                            |
| `PublishedStrategyMetric` | One row per `(strategy, window)`. Precomputed because the leaderboard must `ORDER BY` the score with `skip`/`take` (a JS-computed value cannot be ordered in SQL) and recomputing every publisher's history per request would be a DoS vector. Same precedent as `ProtocolRiskScore` + `src/jobs/protocolRiskScoring.ts`. |
| `StrategyAttribution`     | One row per `(strategy, window)` (#320). Supplies `vsBenchmark` on marketplace entries — merged onto the `PublishedStrategyMetric` page in `getMarketplace` by id, never used for the SQL sort itself. See docs/PERFORMANCE_ATTRIBUTION.md. |

**Partial unique index** (raw SQL in the migration — Prisma cannot express
partial uniques):

```sql
CREATE UNIQUE INDEX "strategy_follows_active_follower_key"
  ON "strategy_follows"("followerUserId") WHERE "unfollowedAt" IS NULL;
```

At most one active follow per user. The service swaps follows inside a
transaction; this index is the structural backstop if that is ever refactored
wrong.

---

## 6. API

All routes require `requireAuth`. Mounted at `/api/v1/strategies` (plus the
deprecated `/api/strategies` alias) via the `apiRoutes` table in `src/index.ts`.

| Method | Path                       | Notes                                              |
| ------ | -------------------------- | -------------------------------------------------- |
| `POST` | `/strategies/publish`      | Upsert + publish the caller's own snapshot         |
| `POST` | `/strategies/unpublish`    | Immediate — drops from marketplace queries at once |
| `GET`  | `/strategies/marketplace`  | `?sortBy=apy\|sharpe&window=30d\|90d&page&limit`   |
| `GET`  | `/strategies/following`    | The caller's active follow, or `{ follow: null }`  |
| `POST` | `/strategies/:id/follow`   |                                                    |
| `POST` | `/strategies/:id/unfollow` | Also releases an orphaned follow                   |

**Not** `/api/agent/strategies/*` as the issue proposed: `src/routes/agent.ts`
sits behind `internalAuthGuard`, an operator/machine guard that authenticates by
`INTERNAL_SERVICE_TOKEN` and **sets no `req.userId`**. User-facing routes cannot
live there.

The path param is `:id` (a `PublishedStrategy` id), deliberately **not**
`:userId` — `enforceUserAccess` compares `req.params.userId` against the caller
and would reject every follow request. Ownership is enforced inside the service
instead.

Pagination defaults are local (`limit` 20, max 50), not `paginationSchema`'s
(`limit` 5): that schema is tuned for WhatsApp transaction lists, not a
leaderboard. The envelope follows the flat `{ page, limit, total, strategies }`
shape of `src/routes/transactions.ts`.

**Self-follow** is disallowed → `StrategySelfFollowError` → 409.

---

## 7. Notifications

Two events on the `WEBHOOK_EVENTS` tuple in
`src/validators/webhook-validators.ts`: `strategy.updated`,
`strategy.unpublished`.

Material-change detection compares the _normalized_ config (`strategyName`,
`targetAllocations` with sorted keys, `riskCeiling`). A label edit is cosmetic
and must not spam followers.

On a material change, inside **one transaction**: bump `configVersion` and
rewrite every active follower's `appliedConfig` / `appliedConfigVersion` /
`appliedAt`. Notifications fire **outside** the transaction via
`Promise.allSettled`, fire-and-forget — a Twilio outage must not roll back a
publish. Dispatch is once per follower (the payload carries `followerUserId`,
matching the per-user convention of `alert_rule.triggered`), so a strategy with
many followers produces a proportional fan-out.

A follower with no `phone` on file is warned-and-skipped, never thrown —
matching `src/jobs/alertRules.ts`.

---

## 8. Edge cases

| Case                                             | Handling                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher unpublishes                            | `isPublished=false` → gone from marketplace queries immediately. Followers keep `appliedConfig`, get `strategy.unpublished`.                  |
| Publisher deletes account                        | `onDelete: SetNull` orphans the follow with its config intact; the agent keeps working. The follow can still be released via `/:id/unfollow`. |
| Self-follow                                      | 409 `StrategySelfFollowError`.                                                                                                                |
| Follow while already following                   | The service closes the previous follow inside one transaction; the partial unique index is the structural backstop.                           |
| Thin track record                                | Excluded from the leaderboard until 30 days **and** 14 samples **and** a computable Sharpe.                                                   |
| Follower has an active `SavingsGoal`             | The goal still wins.                                                                                                                          |
| Publisher's `riskCeiling` looser than follower's | Clamped to the stricter. A follow never widens risk exposure.                                                                                 |
| Config references a delisted protocol            | `applyRiskCeiling` already fails closed; the strategy returns `NO_ELIGIBLE_PROTOCOLS_REASON`.                                                 |
| Publisher closed all positions                   | The metrics job writes ineligible rows rather than leaving stale ones, so they drop off the board.                                            |

---

## 9. Configuration

| Env var                        | Default          | Meaning                                                                                          |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------ |
| `STRATEGY_METRICS_INTERVAL_MS` | `21600000` (6 h) | Metric recompute cadence. Figures derive from hourly snapshots, so faster buys nothing but load. |
| `STRATEGY_RISK_FREE_RATE`      | `0`              | Annual risk-free rate for Sharpe, as a decimal (`0.04` = 4%).                                    |

---

## 10. Known follow-ups (deliberately out of scope here)

1. **`src/jobs/alertRules.ts` duplicates the `valueByInstant` aggregation** that
   `bucketByInstant` now generalizes. It is a tested delivery path and the
   refactor is unrelated to this feature; left alone on purpose.
2. **Pre-existing:** the agent batches users by `(protocol, strategy)` and
   `src/agent/router.ts` reads only `userStrategyPreferences[0]`, so two users with the
   same strategy but _different_ `riskCeiling` values already collapse into one
   batch and both get index-0's ceiling. This feature does not make it worse
   (follows are split per-follow), but it should be fixed independently.
3. **`riskFreeRate`** is a deploy-time constant. Sourcing a live rate is
   deliberately deferred.
