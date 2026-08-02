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
