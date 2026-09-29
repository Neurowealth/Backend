# Spare Change Round-Up Savings Specification

## Overview

The Round-Up Savings engine enables automated micro-savings by rounding up user transactions (such as fiat on-ramp purchases) to a configurable increment (e.g., the nearest $1.00, $5.00, or custom unit), optionally applying a boost multiplier (1x-10x), and batching accrued spare change into automated or on-demand on-chain deposits.

---

## 1. Mathematical Formulation

For each qualifying purchase amount $P$, round-to-nearest increment $R$, and multiplier $M$:

### Spare Change Calculation
$$
A_{\text{round}} = \begin{cases}
0, & \text{if } P \pmod R = 0 \\
\lceil P / R \rceil \cdot R - P, & \text{otherwise}
\end{cases}
$$

### Multiplier Boost & Clamping
$$
M_{\text{clamped}} = \max(1.0, \min(M, M_{\text{max}}))
$$
Where $M_{\text{max}} = 10.0$ by default.

### Total Accrued Round-Up
$$
A_{\text{total}} = A_{\text{round}} \cdot M_{\text{clamped}}
$$

### Boundary Handling
- When $P$ is already an exact multiple of $R$, $A_{\text{round}} = 0$. In this scenario, no accrual record is written, preventing empty zero-value ledger pollution.
- All monetary amounts are normalized to 2 decimal places to eliminate floating point rounding drift.

---

## 2. Invariants and Safety Guarantees

### 2.1 Non-Stranding Balance Invariant
When a user toggles `enabled: false` on their round-up settings:
- New purchases will no longer generate accruals.
- Previously accrued balances (`status: ACCRUED`) remain intact and are never deleted or locked.
- The user can still inspect their accrued balance via `GET /api/v1/round-up/accrual` and execute an on-demand sweep via `POST /api/v1/round-up/sweep`.

### 2.2 Atomic Sweep Concurrency
Sweeping accumulated round-ups into an on-chain deposit is vulnerable to double-spend and duplicate sweep races if concurrent workers run. The sweep engine implements a two-phase state machine:
1. **Atomic Claim**: Eligible accruals (`status: ACCRUED` or stale `EXECUTING` where lease duration exceeds 10 minutes) are updated in bulk to `status: EXECUTING` with the current timestamp.
2. **Deposit Execution**: An on-chain custodial deposit is executed via `executeDeposit`.
3. **Settlement**:
   - On confirmation (`CONFIRMED`), claimed records transition to `status: SWEPT`, storing `sweptAt` and `sweepTransactionId`.
   - On unrecoverable failure or missing wallet, claimed records revert back to `status: ACCRUED` so they can be re-attempted.

### 2.3 Target Goal Fallback
Users may optionally specify a `targetGoalId` linking round-up deposits to an active `SavingsGoal`.
- If the goal exists and is `status: ACTIVE`, the deposit is credited and earmarked to that goal.
- If the goal has been achieved, deleted, or is not in `ACTIVE` status, the sweep engine logs an operational warning and falls back to default unallocated deposit execution rather than dropping or failing the transaction.

---

## 3. Real-Time Event Architecture

Round-up actions publish real-time events over the WebSocket and webhook bus:

| Event Type | Topic | Payload |
| :--- | :--- | :--- |
| `round_up.accrued` | `transactions` | `accrualId`, `orderId`, `purchaseAmount`, `roundUpAmount`, `multiplier`, `totalRoundUp`, `userId` |
| `round_up.swept` | `transactions` | `userId`, `amount`, `accrualCount`, `transactionId`, `targetGoalId`, `sweptAt` |

---

## 4. REST API Specification

### `GET /api/v1/round-up/settings`
- **Scope**: `round_up:read`
- **Response**: Current round-up configuration (`enabled`, `roundToNearest`, `multiplier`, `targetGoalId`).

### `PATCH /api/v1/round-up/settings`
- **Scope**: `round_up:write`
- **Body**:
  - `enabled` (boolean, optional)
  - `roundToNearest` (number, 0.01 - 100, optional)
  - `multiplier` (number, 1 - 10, optional)
  - `targetGoalId` (UUID or null, optional)
- **Response**: Updated configuration.

### `GET /api/v1/round-up/accrual`
- **Scope**: `round_up:read`
- **Response**:
  - `unsweptBalance`: Current un-deposited spare change balance in USD.
  - `currency`: 'USD'.
  - `unsweptCount`: Number of pending accrual items.
  - `accruals`: Detailed history of round-up accruals.

### `POST /api/v1/round-up/sweep`
- **Scope**: `round_up:write`
- **Body**:
  - `force` (boolean, optional): When true, sweeps immediately even if below minimum threshold (default $5.00).
- **Response**: Sweep execution result.
