# Multiple Concurrent Goals with Priority-Weighted Allocation (#358)

## Overview

Users can maintain multiple concurrent `ACTIVE` savings goals (e.g., an emergency fund, a house deposit, and a travel fund) over the same underlying portfolio capital. Rather than creating separate on-chain sub-accounts per goal, goals act as **attributed views** over the user's managed portfolio via the `GoalAllocation` ledger.

---

## Data Model

### `SavingsGoal` Extensions

- `priority` (`Int @default(100)`): Lower numbers are funded first in `SEQUENTIAL` mode.
- `allocationWeight` (`Decimal @default(1)`): Relative share when splitting contributions in `WEIGHTED` mode.
- `fundingMode` (`String @default("SEQUENTIAL")`): `'SEQUENTIAL' | 'WEIGHTED'`.

### `User` Extension

- `goalFundingMode` (`String @default("SEQUENTIAL")`): User-level default funding mode across concurrent active goals.

### `GoalAllocation` Ledger

Each attribution event writes an immutable row in `goal_allocations`:

- `goalId`: Target `SavingsGoal.id`
- `sourceType`: `'DEPOSIT' | 'RECURRING_DEPOSIT' | 'YIELD' | 'REBALANCE_GAIN' | 'MANUAL_REASSIGN' | 'WITHDRAWAL'`
- `sourceId`: Optional reference (`transactionId`, snapshot identifier, or counterparty `goalId` for `MANUAL_REASSIGN`)
- `amount`: Signed `Decimal(36, 18)` delta (`> 0` for inflows, `< 0` for withdrawals or outgoing manual reassignments)

---

## Deterministic Ordering & Funding Modes

### Priority & Tie-Breaking (`sortGoalsByPriority`)

Goals are ordered deterministically by:
1. `priority` ascending (lower integer = higher priority)
2. `targetDate` ascending (sooner deadline first)
3. `createdAt` ascending (older goal first)
4. `id` ascending (final deterministic tie-breaker)

### `SEQUENTIAL` Mode

Incoming contributions fund active goals strictly in priority order up to each goal's remaining headroom (`max(0, targetAmount - currentAmount)`). Any overflow cascades to the next active goal. Once all active goals reach `targetAmount`, any remainder stays in the `unallocated` portfolio bucket.

### `WEIGHTED` Mode

Incoming contributions split across all active under-target goals proportional to `allocationWeight`. If a goal's proportional slice exceeds its remaining headroom (`targetAmount - currentAmount`), it is capped at `targetAmount` and the excess cascades proportionally across the remaining under-target goals (water-filling).

### Yield Attribution (`attributeYield`)

Yield is attributed proportional to each active goal's current attributed balance (`currentAmount`), capped by remaining headroom. A goal holding a larger share of the user's capital earns a proportional share of the portfolio yield.

### Withdrawal Attribution (`attributeWithdrawal`)

Withdrawals reduce attributed capital in **reverse funding order** (`priority` descending, then `allocationWeight` descending, then `targetDate` descending, then `createdAt` descending) so the highest-priority goals (such as an emergency fund) are preserved longest. When a withdrawal is scoped to a specific `positionId`, goals linked to that `positionId` are reduced first. No goal's attributed balance ever drops below `0`.

### Achieved Goals

When a goal's attributed balance reaches `targetAmount`, it transitions to `ACHIEVED` and stops receiving new contribution or yield attributions. Its held capital remains attributed to it until the user withdraws or manually reassigns it via `POST /api/v1/goals/:id/reassign`.

---

## Agent Strategy Selection (`selectBindingGoal`)

- **Single active goal**: Behaves byte-for-byte identically to #281 (`targetAmount`, `startingAmount`, `targetDate`, and `riskCeiling` passed directly to `GoalTrackingStrategy`).
- **Multiple active goals**:
  - **Binding goal**: The agent selects the under-funded active goal (`currentAmount < targetAmount`) with the **highest `requiredApy`** (ties broken by `sortGoalsByPriority`).
  - **Stricter risk ceiling**: Because `riskCeiling` is a minimum required protocol safety score (`score >= riskCeiling`), the effective ceiling across all active goals is the **maximum** (`Math.max`) of all configured goal ceilings.

---

## API Endpoints

- `GET /api/v1/goals` (and `GET /api/v1/portfolio/goals`): Returns all goals ordered by priority, each with its `GoalProgress`, attributed `currentAmount`, `portfolioShare`, and the user's `unallocated` remainder.
- `PUT /api/v1/goals/:id` / `PATCH /api/v1/goals/:id`: Updates `priority`, `allocationWeight`, `fundingMode`, `targetAmount`, `targetDate`, `riskCeiling`, or `includeExternalHoldings`.
- `POST /api/v1/goals/:id/reassign`: Moves `amount` of attributed capital from `:id` to `toGoalId` by writing paired `-amount` / `+amount` `MANUAL_REASSIGN` rows while preserving the total attributed sum invariant.
