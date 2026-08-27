# Portfolio Optimization & Allocation Suggestions (#322)

Computes a mean-variance optimal allocation from historical protocol APY data,
the user's risk tolerance, and their effective risk ceiling — and returns it with
an efficient frontier and a backtest comparison.

**Everything here is advisory.** Read [The advisory
invariant](#the-advisory-invariant) before changing anything in `src/analytics/`.

---

## The advisory invariant

A suggestion is computed, persisted to `AllocationSuggestion`, and displayed.
It **never**:

- writes `User.strategyConfig` or `User.rebalanceStrategy`
- moves funds, touches a wallet, or imports anything from `src/stellar/`
- changes what the rebalancing agent does on its next tick

Applying a suggestion is a separate, deliberate act by the user through the
existing strategy update path, which already validates the config
(`publishableConfigSchema`) and already logs the change.

This is enforced structurally, not by convention.
`tests/unit/analytics/structural.test.ts` scans the source text of every
`src/analytics/*` file and of `src/jobs/allocationSuggestions.ts`, and fails on
any `user.update`, any `strategyConfig:` write, any `src/stellar/` import, and
any Prisma model access outside a fixed allowlist.

The reason for the paranoia: an optimizer that can silently rewrite where
someone's money sits is a fundamentally different — and far more dangerous —
feature than one that draws a chart.

---

## Units

Everything in `src/analytics/` that is a rate or a weight is a **decimal
fraction**:

| Quantity | Example | Means |
|---|---|---|
| expected return | `0.082` | 8.2% APY |
| volatility | `0.014` | 1.4 percentage points of APY volatility |
| weight | `0.425` | 42.5% of the portfolio |

The **only** place fractions become percentages is `toPercentageAllocations`
(`src/analytics/optimizer.ts`), which emits the 0–100 map that
`User.strategyConfig.targetAllocations` speaks. Keeping the conversion at exactly
one boundary is what makes the "sums to 100 ± 0.01" invariant assertable in one
place — and ± 0.01 is precisely the tolerance
`publishableConfigSchema.superRefine` already enforces, so a suggestion is
directly acceptable by the existing update path with no re-conversion.

---

## The objective

```
maximize   μᵀw − (λ/2)·wᵀΣw

subject to Σw = 1
           lo_i ≤ w_i ≤ hi_i
           Σ_{i∈S} w_i ≥ f          (optional stable-group floor)
```

The risk ceiling is **not** a term in this objective. It enters upstream as a
universe filter, reusing the same fail-closed rule as `applyRiskCeiling`
(`src/agent/strategies.ts`): a protocol with no known score is excluded rather
than given the benefit of the doubt. A weighted portfolio risk score is
*reported* for display but never separately constrained — one notion of the
ceiling, not two.

### What the covariance actually measures

`ProtocolRate` is a **yield-quote series, not a price series**. Σ here is the
covariance of protocols' quoted annual rates, so the optimizer minimizes **yield
volatility** — how much a protocol's APY swings around.

It does **not** model principal loss, depeg, or smart-contract failure. Those
live in `ProtocolRiskScore`, which enters as the universe filter above. This
limitation is repeated in the API response `disclaimer` rather than left for a
user to infer from a confident-looking chart.

---

## Risk aversion (λ)

```
λ(rt) = LAMBDA_MAX · (LAMBDA_MIN / LAMBDA_MAX) ^ ((rt − 1) / 9)
```

with `LAMBDA_MAX = 500` (riskTolerance 1, most risk-averse) and
`LAMBDA_MIN = 5` (riskTolerance 10). Log-spaced, because each step of risk
appetite is naturally a constant *ratio* rather than a constant difference.
Values outside 1–10 are clamped — `User.riskTolerance` is an `Int` column with no
database-level range check.

### Why this range, and why Σ is scaled the way it is

> This is a deliberate, measured deviation from the original plan for #322.
> Recorded in `ASSUMPTIONS.md`.

The plan specified daily returns `r = apy/100/365.25`, Σ annualized by
`× 365.25`, and λ linear on `[1, 25]`. Under those units the risk term sits
**five to six orders of magnitude below the return term** for realistic APY
dispersion. A protocol whose APY swings ±2 percentage points has an annualized
variance of ~`5e-7` in that scaling, against a mean return of ~`8e-2`:

| λ | `(λ/2)·wᵀΣw` at w=1 | μ | ratio |
|---|---|---|---|
| 1 | 5.48e-7 | 0.08 | 1.5e+5 |
| 25 | 1.37e-5 | 0.08 | 5.8e+3 |

The consequence is not "slightly aggressive". `(λ/2)wᵀΣw` can never offset `μᵀw`
at any λ in `[1, 25]`, so the optimum is **always** the max-return corner, the
efficient frontier collapses to a single point, and the engine degenerates into
"put everything in the highest-APY protocol".

So Σ here is the covariance of **annual rate levels** — exactly the plan's matrix
multiplied by 365.25. Two things follow:

- `expectedVolatility` comes out in the same units as the APY itself, so
  "8.2% expected return, 1.4% expected volatility" reads directly.
- λ must live on `[5, 500]` to span the useful trade-off. For two protocols at
  μ = 10%/6% and σ = 3%/1%, the optimal weight in the riskier one is:

  | λ | 1 | 25 | 64 | 100 | 500 |
  |---|---|---|---|---|---|
  | w | 1.00 (corner) | 1.00 (corner) | 0.72 | 0.50 | 0.18 |

---

## The concentration cap

`DEFAULT_MAX_WEIGHT_PER_PROTOCOL = 0.6`, raised to `1/n` when the universe is too
small to satisfy it.

Unconstrained mean-variance is famously corner-seeking (Michaud's "error
maximization"): it treats a historical mean as if it were known exactly, so a
protocol whose APY averaged 3 percentage points above its peers absorbs the whole
book unless something stops it. Measured on this repo's own scale — a 3pp return
spread against ~1.8pp yield volatility, with the correlated rate histories DeFi
protocols actually exhibit — **every riskTolerance from 3 to 10 returned a single
protocol at 100%.**

That is a true optimum of the stated objective and simultaneously terrible
advice. The cap is applied as an explicit, documented, **overridable** constraint
(an explicit `bounds.max` wins over it) rather than by quietly distorting μ or λ
until the answer looked reasonable.

---

## Estimation

`src/analytics/estimation.ts`, zero I/O.

1. **Universe eligibility** — fail-closed at every step. A protocol is admitted
   only when it has a `ProtocolRiskScore` row, that row is not flagged
   `insufficientHistory`, it clears any configured ceiling, and it has rate
   history in the window. Everything else is excluded **with a machine-readable
   reason**, so the API can always explain a missing protocol.
2. **Daily aggregation** — `ProtocolRate` is keyed by
   `(protocolName, assetSymbol, network, fetchedAt)`, so a protocol routinely has
   several rows per day. These are averaged to one value per `(protocol, UTC
   day)` first, making the daily value a property of the day rather than an
   artifact of scan ordering.
3. **Alignment** — `buildDailyRateSeries` (`src/agent/backtest.ts`) forward-fills
   onto a common daily grid, then only days on which *every* admitted protocol
   has a value are kept.
4. **Statistics** — `x_p(t) = apy_p(t)/100`; `μ_p = mean(x_p)`;
   `Σ = sampleCovariance(x)` using the **n−1** convention, matching
   `sampleStdev` in `src/agent/strategyMetrics.ts` (which this module imports
   rather than copying — that file declares itself the one definition of
   risk-adjusted return math).

### Why not `periodReturns`

A covariance matrix requires **index-aligned** observation vectors: entry (i,j)
must pair protocol i and protocol j on the *same* day.

`periodReturns` (`src/agent/strategyMetrics.ts`) cannot supply that. It **skips**
any interval whose starting value is non-positive — correct for its own job (a
portfolio funded from empty is a deposit, not a return) but fatal here: two
protocols skipping different intervals produce vectors of different lengths whose
k-th entries are different days. The resulting matrix looks perfectly well-formed
and is silently, badly wrong.

### The smoothing trap

Inputs derive from `ProtocolRate.supplyApy`, a per-observation rate quote. They
must **never** derive from `YieldSnapshot.apy`, which `snapshotter.ts` computes as
cumulative-yield-since-`openedAt` annualized — consecutive values there are a
smoothed running average whose variance badly understates reality. Same trap
documented in `docs/STRATEGY_MARKETPLACE.md` §2.

---

## The solver

Accelerated projected gradient ascent (FISTA) with adaptive restart. No new
dependency — the repo has an explicit hand-roll precedent (`src/utils/csv.ts`,
`src/agent/strategyMetrics.ts`).

- **Projection onto `{Σw = 1, lo ≤ w ≤ hi}` is exact.**
  `w_i(θ) = clamp(v_i − θ, lo_i, hi_i)` is monotone non-increasing in θ, so
  bisection on θ converges to machine precision — no tolerance to tune.
- **The stable-group floor uses an exact split, not Dykstra.** For a convex set
  ∩ halfspace, the projection is either the plain capped-simplex projection or it
  lies on `Σ_S w = f`, which is
  `{Σ_S w = f} ∩ {Σ_{Sᶜ} w = 1−f} ∩ box` — two capped simplices over *disjoint*
  index groups. Euclidean distance separates across disjoint coordinates, so
  projecting each group onto its own target sum is the exact projection. No
  iteration, and the floor cannot be left violated.
- **Why acceleration.** Σ is a sample covariance over ~90 observations, so with
  many protocols — or protocols whose APYs move together, which is the norm — it
  is ill-conditioned or rank-deficient. The objective is then concave but not
  *strongly* concave, and plain projected gradient converges at O(1/k). Measured:
  a 7-protocol problem still had a 5.2e-8 residual after the full 2000-iteration
  budget. Nesterov momentum gives O(1/k²) for the same per-iteration cost;
  adaptive restart (drop momentum whenever an iterate is worse than its
  predecessor) keeps it effectively monotone.

**Determinism.** Protocols are sorted by name and μ/Σ permuted to match
regardless of caller ordering, the starting point is the uniform vector projected
onto the feasible set, the iteration budget is fixed, and there is no randomness
anywhere. The same input produces byte-identical output.

**Every iterate is a projection onto the feasible set**, so every intermediate
value satisfies every constraint — which is what makes `bestFeasibleWeights` safe
to return on a `non_converged` outcome.

### Measured cost

Full solve plus a 12-point frontier sweep:

| Protocols | Time |
|---|---|
| 3 | 0.11 ms |
| 10 | 1.33 ms |
| 25 | 7.10 ms |

Across 450 seeded random problems (up to 25 protocols): 0 non-converged, median
104 iterations, max 802 of a 2000 budget.

---

## Outcomes

A discriminated union — every failure mode is a named, inspectable state rather
than a plausible-looking vector that quietly violates a constraint.

| `status` | Meaning |
|---|---|
| `ok` | Weights, expected return/volatility, λ, frontier, iterations, portfolio risk score. |
| `infeasible` | The constraints contradict each other. Names the `bindingConstraint` (`minWeights`, `maxWeights`, `stableFloor`). |
| `insufficient_universe` | Fewer than 2 eligible protocols, with per-protocol exclusion reasons. Carries `bindingConstraint: riskCeiling` when the ceiling is what emptied it. |
| `non_converged` | Budget exhausted. Carries the best **feasible** vector found plus the residual — never a converged-looking answer. |

All four are HTTP **200**: "the optimizer ran and could not produce a portfolio"
is a result, not a request error.

---

## Effective risk ceiling

The agent resolves this with **two deliberately different merge rules**, and a
suggestion computed under a third would be advice about a portfolio the agent
will never build. Both are mirrored verbatim in `src/analytics/service.ts`:

1. A **followed** strategy merges via `stricterRiskCeiling` (`Math.max` — higher
   score means lower risk, so a follow may only ever *tighten* exposure). See
   `src/agent/effectiveStrategy.ts`.
2. An **ACTIVE `SavingsGoal`** then *overrides* via `??`, matching
   `src/agent/router.ts` — a stated personal target outranks a copied config, and
   it may legitimately loosen the ceiling.

Unifying these into one rule would be tidier and wrong. The response reports
`ceilingSource` (`goal` | `follow` | `own` | `none`) so the resolution is visible.

---

## The backtest comparison

### What it actually simulates

The agent has **no multi-protocol position model**: `Position.protocolName` is a
single string, `StrategyDecision.targetProtocol` is a single string, and
`TargetAllocationStrategy` uses weights only to *rank a single hop*. So this
cannot and does not simulate holding a weighted basket.

It replays what the **existing agent would have done** under each weight vector,
which is the honest question given the engine that exists. The `caveat` string
travels with the data into the API response rather than living only here.

`current` is null when the user has no allocation configured — an invented
baseline would be worse than none.

The window is trimmed to the first day that actually has data. `runBacktest`
treats an empty first day as `insufficient_history` and abandons the whole run,
which would otherwise discard 89 good days over a timestamp-alignment artifact.

---

## API

| Method | Path |
|---|---|
| `POST` | `/api/v1/portfolio/:userId/suggest-allocation` |
| `GET` | `/api/v1/portfolio/:userId/suggestions` |

Both are `requireAuth → enforceUserAccess → validate(...)`, keyed on
`req.params.userId`. That keying is load-bearing: a body-only or
resource-id-keyed route (`/suggestions/:id`) would make `enforceUserAccess` a
silent no-op — the trap documented in `CLAUDE.md` — and would also skip the
sub-account permission lookup, which reads the same param.

They are registered **before** `GET /:userId`, following the same defensive
placement as `router.use('/goals', goalsRouter)`.

### Cost controls

Two layers, because they bound different things:

- **`optimizerRateLimiter`** (default 5/min) bounds requests per *window*.
  Applied per-endpoint rather than through the `apiRoutes` table, which would
  throttle all read-only portfolio traffic because one POST on the same router is
  expensive. This is not the double-application the warning in
  `src/routes/admin.ts` guards against — no table limiter applies to this route.
- **`ConcurrencyLimiter`** (`src/utils/concurrency.ts`) bounds how many run *at
  once*: one per user, plus a small global budget. The optimizer is the first
  genuinely CPU-bound thing in this API and runs on the single event-loop thread,
  so ten concurrent solves do not merely run slower — they block every other
  request in the process, including `/health/ready`. Non-blocking: it returns 429
  immediately rather than queueing.

---

## Persistence and the scheduled job

`AllocationSuggestion` rows are kept rather than replaced, so a user can see how
the recommendation moved as their inputs changed.

`weights` is `Json` **percentages**, not `Decimal` — a deliberate deviation from
the issue's "use Decimal for storage". The vector's entire purpose is to
round-trip into `User.strategyConfig.targetAllocations`, itself a `Json` map of
numbers; storing `Decimal` would force a lossy re-conversion at the one place the
value is ever consumed. `PublishedStrategyMetric` already sets the
Float-for-computed-analytics precedent.

`inputHash` is a `sha256:`-prefixed hash over the canonical input snapshot
(sorted universe, μ, Σ, riskTolerance, effective ceiling, lookback), with numbers
fixed to 9 decimal places — far finer than any difference that moves a weight,
coarse enough that float noise cannot flip the hash. **Equal hashes must mean
equal weights**; that is what makes "did my recommendation change, or only my
inputs?" answerable.

`src/jobs/allocationSuggestions.ts` refreshes suggestions every 6 h
(`ALLOCATION_SUGGESTION_INTERVAL_MS`) for users with an ACTIVE `Position`. It
**skips the backtest legs** — two full historical replays per user, only
interesting when a human is looking. Rows written by the job therefore carry a
null `backtest`; that is expected, not a failure.

### `scheduleProtocolRiskScoring` is now wired up

`src/jobs/protocolRiskScoring.ts` existed but was never imported or started, so
`ProtocolRiskScore` was never refreshed after its first backfill. Because
risk-ceiling filtering is fail-closed, a stale or empty table makes every
ceiling-constrained suggestion — and every ceiling-constrained *rebalance* —
return nothing eligible. It is now started in `src/index.ts`, before the
suggestion job, and cleared in `gracefulShutdown`.

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ALLOCATION_SUGGESTION_INTERVAL_MS` | `21600000` (6 h) | Precompute cadence. |
| `ALLOCATION_SUGGESTION_MAX_CONCURRENT` | `2` | Global in-flight optimization budget. |
| `ALLOCATION_SUGGESTION_BATCH_SIZE` | `25` | Users per batch in the job. |
| `OPTIMIZER_RATE_LIMIT_WINDOW_MS` | `60000` | Optimizer rate-limit window. |
| `OPTIMIZER_RATE_LIMIT_MAX` | `5` | Requests per window. |

All optional with defaults, so no `.env.test` or CI stub is required.

---

## Out of scope

Per the issue: automated execution of suggestions, live market feeds,
multi-asset correlation models, and ML return prediction.
