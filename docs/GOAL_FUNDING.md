# Goal-Linked Auto-Contributions with Catch-Up Sizing (#357)

Links a `RecurringDepositPlan` (#282) to a `SavingsGoal` (#281) and computes each contribution dynamically from the gap between the goal's projected trajectory and its target, clamped within user-configured `[minAmount, maxAmount]` bounds.

---

## 1. Schema Fields (`RecurringDepositPlan`)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `savingsGoalId` | `String?` | `null` | Foreign key to an `ACTIVE` owned `SavingsGoal`. |
| `sizingMode` | `String` | `"FIXED"` | `"FIXED"` or `"GOAL_CATCH_UP"`. |
| `minAmount` | `Decimal?` | `null` | Lower bound per run when `sizingMode = "GOAL_CATCH_UP"`. |
| `maxAmount` | `Decimal?` | `null` | Mandatory upper bound per run when `sizingMode = "GOAL_CATCH_UP"`. |
| `catchUpHorizon` | `String` | `"SPREAD_REMAINING"` | `"NEXT_RUN"` (close gap immediately) or `"SPREAD_REMAINING"` (amortize over remaining cadence runs). |
| `lastShortfall` | `Decimal?` | `null` | Shortfall recorded on the most recent catch-up run. |
| `lastClampedBy` | `String?` | `null` | Bound that clamped the most recent catch-up run (`"min"`, `"max"`, or `null`). |

---

## 2. Catch-Up Sizing Math (`src/goals/contributionSizing.ts`)

Uses the same non-compounding APY convention as `src/goals/service.ts` and `GoalTrackingStrategy`:

1. **Projected value at `targetDate` under baseline contributions**:
   $$\text{projectedFromCurrent} = \text{currentAmount} \times \left(1 + \frac{\text{actualApy}}{100} \times \text{yearsRemaining}\right)$$
   $$\text{scheduledContributions} = \text{remainingRuns} \times \text{baseAmount}$$
   $$\text{projectedValue} = \text{projectedFromCurrent} + \text{scheduledContributions}$$
   $$\text{shortfall} = \text{targetAmount} - \text{projectedValue}$$

2. **Horizon adjustment**:
   - `NEXT_RUN`: $\text{unclamped} = \text{baseAmount} + \text{shortfall}$
   - `SPREAD_REMAINING`: $\text{unclamped} = \text{baseAmount} + \frac{\text{shortfall}}{\text{remainingRuns}}$

3. **Bounds & Ahead-of-Target Floor**:
   - When ahead of target ($\text{shortfall} < 0$), the contribution reduces toward `minAmount`.
   - If `minAmount` is unset, it floors at `DEFAULT_AHEAD_FLOOR_FRACTION` ($25\%$) of `baseAmount` (`clampedBy = "min"`).
   - If $\text{unclamped} > \text{maxAmount}$, it clamps to `maxAmount` (`clampedBy = "max"`).
   - When `actualApy` is unavailable ($0$ or no positions yet), projections default to $0\%$ APY (contributions only) with an explicit `caveat` in `projectionBasis`.

---

## 3. Job Execution & Edge Cases (`src/jobs/recurringDeposits.ts`)

- **Atomic claim first**: `claimDuePlan` runs before sizing so concurrent job ticks never double-size or double-submit.
- **Auto-pause on `ACHIEVED` / `CANCELLED`**: When a linked goal reaches `ACHIEVED` or is `CANCELLED` (either at goal update time or when inspected by the job), the `GOAL_CATCH_UP` plan automatically pauses (`status = "PAUSED"`, `lastRunStatus = "paused_goal_achieved"` or `"paused_goal_inactive"`).
- **Capped contribution event**: When `clampedBy === "max"` and a shortfall remains after the run, the job emits `goal.contribution_capped` alongside `recurring_deposit.executed`.
- **Insufficient balance degradation**:
  - If available balance is below the derived amount but $\ge \text{minAmount}$ (or $25\%$ floor), the run deposits the available balance (`lastRunStatus = "executed_partial_balance"`, ledger status `"PARTIAL"`).
  - If available balance is below `minAmount`, the run is skipped (`lastRunStatus = "skipped_insufficient_balance"`) and notifies the user without attempting a failing on-chain transaction.

---

## 4. API Endpoints

- `POST /api/v1/recurring-deposits` (and `/api/v1/deposit/recurring`) — Create a plan with optional `savingsGoalId`, `sizingMode`, `minAmount`, `maxAmount`, `catchUpHorizon`.
- `PATCH /api/v1/recurring-deposits/:id` — Update catch-up link, mode, bounds, or horizon.
- `GET /api/v1/recurring-deposits/:id/preview` — Deterministically project the next $N$ run amounts, including `estimatedCompletionDate`, `daysLate`, and `completionSummary` (`"At these limits the goal completes ~YYYY-MM-DD, N days late."`).
- `GET /api/v1/goals/:id/funding` (and `/api/v1/portfolio/goals/:id/funding`) — Inspect all recurring deposit plans linked to a goal and whether current settings put the goal on track.
