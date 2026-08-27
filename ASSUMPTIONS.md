# Assumptions

Documented, reasonable assumptions made while implementing features, so a
reviewer can override any of them without archaeology.

---

## Issue #285 — Strategy Marketplace / Opt-In Copy-Trading

1. **`strategyConfig` serializes exactly `{ strategyName, targetAllocations?,
riskCeiling? }`** — the three keys `src/agent/loop.ts` actually reads.
   `riskTolerance` stays personal to the follower and is never copied.

2. **The risk-free rate for Sharpe is 0**, exposed as
   `STRATEGY_RISK_FREE_RATE`. Stating it explicitly beats a hidden non-zero
   assumption. Sourcing a live rate is deferred.

3. **Metric recompute interval defaults to 6 h**
   (`STRATEGY_METRICS_INTERVAL_MS`), matching `config.protocolRisk.intervalMs`.
   Figures derive from hourly snapshots, so a faster cadence buys nothing.

4. **Publishing does not require an eligible track record.** A publisher simply
   does not appear on the leaderboard until they have one. This keeps publishing
   and ranking independent.

5. **`GOAL_TRACKING` is not publishable.** It is driven by the publisher's own
   `SavingsGoal` target and date — personal figures that mean nothing to a
   follower and would have to be copied for the strategy to work at all.
   Followers with their own goal already get goal precedence.

6. **`POST /strategies/publish` accepts an explicit `strategyConfig`, and
   snapshots the caller's `User.rebalanceStrategy` / `User.strategyConfig` when
   it is omitted.** Nothing in `src/` currently _writes_ those User columns, so
   an explicit body is the only way the feature is usable today; the snapshot
   path is there for when a "set my strategy" endpoint lands.

7. **`TARGET_ALLOCATION` weights must sum to 100.** Followers inherit them
   verbatim, so a set that does not sum to 100 would quietly under- or
   over-allocate someone else's funds.

8. **DEVIATION from the plan's signature:** `computeStrategyMetrics` takes an
   input object with a separate `firstObservedAt` rather than
   `(points, now?)`. The window governs the _return statistics_; the track
   record governs _trust_. Deriving the track record from the windowed series
   would make the 30-day window structurally incapable of ever reaching a
   30-day track record (its oldest sample sits ~30 days back and floors to 29),
   leaving the 30-day leaderboard permanently empty.

9. **Follower notifications dispatch once per follower**, not once per event,
   because a webhook consumer needs to know whose agent is affected — matching
   the per-user payload convention of `alert_rule.triggered`. A strategy with
   many followers therefore produces a proportional webhook fan-out.

10. **Unfollow tolerates an orphaned follow.** When a publisher deletes their
    account, `onDelete: SetNull` leaves the follower with no strategy id to
    name. `POST /strategies/:id/unfollow` releases the caller's active follow
    when its `publishedStrategyId` is null, regardless of the id supplied. It
    only ever touches the caller's own single active row, so the looser match is
    not a privilege boundary.

11. **The metrics job computes for unpublished strategies too**, so re-publishing
    is ranked immediately instead of waiting up to a full interval. The
    marketplace query, not the job, applies the `isPublished` filter.

## Portfolio Optimization & Allocation Suggestions (#322)

12. **Σ is the covariance of ANNUAL RATE LEVELS, not of daily returns**, and λ is
    log-spaced over `[5, 500]` rather than linear over `[1, 25]`. Both deviate
    from the issue plan, and they are one decision, not two. Under the plan's
    scaling (`Σ = cov(apy/100/365.25) × 365.25`) the risk term sits five to six
    orders of magnitude below the return term for realistic APY dispersion, so
    `(λ/2)wᵀΣw` can never offset `μᵀw` at any λ in `[1,25]`: the optimum is
    always the max-return corner and the efficient frontier collapses to a point.
    The chosen Σ is exactly the plan's matrix × 365.25, which also makes
    `expectedVolatility` read in the same units as the APY. Worked numbers in
    `docs/PORTFOLIO_OPTIMIZATION.md`.

13. **A default 60% per-protocol concentration cap is applied**, raised to `1/n`
    on a small universe. Unconstrained mean-variance is corner-seeking; measured
    on this repo's scale, every `riskTolerance` from 3 to 10 returned a single
    protocol at 100%. That is a true optimum of the stated objective and
    simultaneously terrible advice for an endpoint whose purpose is to suggest a
    *diversified* allocation. Applied as an explicit, overridable `bounds.max`
    default rather than by distorting μ or λ until the answer looked reasonable.

14. **The stable-group floor uses an exact disjoint-group split projection**,
    not the Dykstra alternating projections the plan called for. For a convex set
    ∩ halfspace the projection is either the plain capped-simplex projection or
    lies on `Σ_S w = f`, which splits into two capped simplices over disjoint
    index groups — exact and non-iterative. Dykstra is correct for a general
    intersection but only iteratively convergent, and the first draft left the
    iterate on the wrong side of the floor (returning 0.30 for a 0.60 floor).

15. **`insufficient_universe` carries an optional `bindingConstraint`.** A
    too-tight risk ceiling empties the universe rather than emptying the feasible
    set, so reporting it as `infeasible` would mislabel it. The extra field lets
    the API name `riskCeiling` as the cause while keeping the outcome
    structurally accurate.

16. **The backtest window is trimmed to the first populated day.** `runBacktest`
    treats an empty first day as `insufficient_history` and abandons the entire
    run, so a first observation landing minutes after the window's opening
    midnight would discard ~89 otherwise-usable days. Trimming makes the
    comparison depend on the data that exists rather than on when the rate
    scanner happened to run.

17. **The scheduled job stores suggestions without backtest legs.** They are two
    full historical replays per user and are only interesting when a human is
    looking, which is exactly when the POST endpoint computes them live. Rows
    written by the job carry a null `backtest`; that is expected, not a failure.

18. **`prisma/migrations/20260728000000_add_sub_accounts/rollback.sql` was
    written here despite being out of scope for #322.** It was missing, which
    fails `scripts/check-migration-rollback.sh` on `main` and would have left
    this branch's CI red for an unrelated reason. Flagged in the PR description.

---

## Issue #316 — Authenticated Real-Time WebSocket Streaming

1. **The durable stream is Postgres, not a Redis Stream.** `src/config/redis.ts`
   degrades to a no-op when `REDIS_URL` is unset — the configuration most
   environments and the whole test suite run — so a Redis-backed stream would
   make `resume afterSeq` silently unavailable exactly where it is hardest to
   notice, and would put durability on a store we treat elsewhere as a cache.
   Redis stays in the design as the cross-pod *transport*. Justified in code on
   `model UserEvent` in `prisma/schema.prisma`.

2. **Stream retention defaults to 7 days and 5000 rows per user.** This table
   exists to close a reconnect gap, not to be a second event log — `Transaction`
   and `ProcessedEvent` remain the durable record. Both bounds are needed: age
   alone lets one pathological account grow without limit inside the window.

3. **`seq` is exposed to clients as a JSON `number`, not a string.** Postgres
   returns `BIGINT` and Prisma maps it to `bigint`, which `JSON.stringify`
   refuses. A per-user counter would need to pass 2^53 events before the
   conversion could lose precision.

4. **`subscribe` starts at "now"; only `resume` replays.** A client that wants
   history asks for it. Making `subscribe` replay by default would turn every
   fresh connection into a retention-sized read.

5. **Coalescing is opt-in per subscription and lossy for `resume`.** Suppressed
   events stay in the store but are not redelivered, because the client's
   `afterSeq` has already moved past them. Default-off makes that the client's
   trade, not the server's.

6. **A revoked session is caught by polling, not by a push.** `WS_SESSION_RECHECK_MS`
   (60s) re-verifies each live socket. Polling is the one mechanism that covers
   every way a session can die — logout, expiry, deactivation, admin action —
   without each of those code paths needing to know sockets exist. Logout
   additionally closes sockets immediately on the pod handling it.

7. **Delegated topic mapping: `VIEW` → portfolio/transactions/agent/alerts,
   `MANAGE_STRATEGY` → strategies.** `DEPOSIT`/`WITHDRAW` add no topics of their
   own — the confirmations they produce are already covered by `transactions`
   under `VIEW`.

8. **The webhook leg still receives the unredacted payload.** Webhook
   subscriptions are operator-scoped and their endpoints are trusted servers;
   an end user's browser is not. Only the socket payload is projected onto the
   per-event-type allowlist.

9. **`agent.rebalanced` from `src/stellar/events.ts` has no user stream.** The
   contract event is protocol-wide with no user to address, so it publishes with
   an empty user list and reaches the webhook channel alone. The per-user view
   of a rebalance comes from `src/agent/loop.ts`, which knows whose positions
   moved.

10. **A `?token=` query parameter is deliberately unsupported.** URLs reach
    access logs, proxy logs, and referrers, and the handshake token is a live
    session. Browsers use the `Sec-WebSocket-Protocol: bearer, <jwt>` pair.
