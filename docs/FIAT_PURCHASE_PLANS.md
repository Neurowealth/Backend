# Scheduled Fiat Purchases (Card-Funded DCA) — `#361`

Scheduled Fiat Purchases extend NeuroWealth's recurring deposit automation (`#291`) and multi-provider fiat on-ramp (`#290` / `#313`) so users can set up recurring fiat-to-crypto purchases funded by an opaque provider-side payment instrument (`paymentMethodRef`) with optional automatic vault deposit (`autoDeposit`) upon on-chain settlement.

---

## 1. Security & Payment Instrument Handling

- **Zero PCI Scope**: NeuroWealth never accepts, logs, or stores raw card numbers (PANs), CVVs, or expiration dates.
- **`paymentMethodRef`**: Must be an opaque provider token (e.g., `pm_moonpay_tok_abc123`). Input validation (`paymentMethodRefSchema`) explicitly rejects strings matching 13–19 digit card PAN patterns.
- **Sub-Account & Compliance Enforcement**:
  - Sub-accounts (`#353`) without `DEPOSIT` permission cannot create, update, or cancel purchase plans (`403 Forbidden`).
  - Users under a compliance freeze (`User.isFrozen = true`, `#319`) cannot create plans, and any active plan owned by a frozen user is automatically paused (`pauseReason = "compliance_freeze"`) on its next scheduled tick without calling the ramp provider.
- **Tamper-Evident Audit Log (`#315`)**: Plan creation, updates, pause/resume transitions, and cancellations append entries to the hash-chained `AuditLog` (`fiat_purchase_plan.created`, `fiat_purchase_plan.updated`, `fiat_purchase_plan.paused`, `fiat_purchase_plan.resumed`, `fiat_purchase_plan.cancelled`).

---

## 2. Run State Machine

Each scheduled occurrence `(planId, scheduledFor)` is tracked by a single `FiatPurchasePlanRun` row enforced by a database unique constraint `@@unique([planId, scheduledFor])`.

```
                  ┌──────────────────────────────────────┐
                  │         scheduled occurrence         │
                  └──────────────────┬───────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
             [skipped_rate]  [action_required] [awaiting_settlement]
           (slippage > max)   (3-DS / KYC URL)        │
                                     │                │
                        ┌────────────┴────┐           ├─────────────────────────┐
                        ▼                 ▼           ▼                         ▼
                    [failed]         (settled)   [completed]       [completed_deposit_pending]
                 (24h timeout)            │     (autoDeposit=false   (fiat settled, vault
                                          │      or deposit ok)       deposit failed)
                                          └───────────▲
```

### Terminal & Intermediate Statuses

| Status | Meaning |
|---|---|
| `awaiting_settlement` | `FiatOrder` created with provider; waiting for on-chain settlement (`FiatOrder.status = SETTLED`) via webhook + reconciliation. |
| `action_required` | Provider requires interactive 3-DS challenge or KYC step (`actionUrl` populated). Emits `fiat_purchase.action_required`. Times out to `failed` if unresolved within `FIAT_PURCHASE_ACTION_TIMEOUT_MS` (default 24 hours). |
| `skipped_rate` | Live best-execution quote rate drifted below the reference rate (`lastExecutedRate ?? baselineRate`) by more than `maxSlippagePct`. Emits `fiat_purchase.skipped`; does **not** increment `consecutiveFailures`. |
| `completed` | Fiat leg settled on-chain (`FiatOrder.status = SETTLED`) and, when `autoDeposit = true`, the vault deposit via `executeDeposit()` succeeded (`depositTxHash` recorded). Emits `fiat_purchase.completed`. |
| `completed_deposit_pending` | Fiat leg settled on-chain, so funds are safely in the user's wallet, but the subsequent vault `executeDeposit()` failed or was gated. The fiat leg is **never** retried or double-charged. |
| `failed` | Provider order creation failed, provider webhook reported `FAILED`/`REFUNDED`, 3-DS challenge timed out, or `awaiting_settlement` exceeded `FIAT_PURCHASE_SETTLEMENT_TIMEOUT_MS` (default 48 hours). |

---

## 3. Idempotent Retry & Hard-Decline Semantics

1. **Per-Occurrence Idempotency (`@@unique([planId, scheduledFor])`)**:
   - Retries of a failed occurrence reuse the existing `FiatPurchasePlanRun` row (`attemptCount` incremented) and pass a deterministic idempotency key (`fiat-plan-run:<planId>:<scheduledFor>:<attempt>`) so a retry never double-charges the card.
2. **Soft vs. Hard Declines**:
   - **Soft failures** (provider timeout, network error, `insufficient_funds`, `try_again_later`): Retried up to `retryPolicy.maxAttempts` (default `3`) with exponential backoff `backoffMinutes * 2^(attempt - 1)` while keeping `scheduledFor` pinned to the failed occurrence.
   - **Hard declines** (`expired_card`, `stolen_card`, `invalid_payment_method`, `card_declined_hard`, `do_not_honor`, `fraud_suspected`): Immediately transition the plan to `PAUSED` (`pauseReason = "hard_decline: <code>"`) without burning remaining retry attempts.
   - **Retry Exhaustion**: When `attemptCount >= maxAttempts`, `consecutiveFailures` increments on the plan. Reaching `maxAttempts` consecutive failed occurrences auto-pauses the plan (`status = PAUSED`, `pauseReason = "max_consecutive_failures_exceeded"`) and emits `fiat_purchase.failed`.

---

## 4. REST Endpoints

| Method | Path | Scope | Description |
|---|---|---|---|
| `POST` | `/api/v1/fiat/purchase-plans` | `fiat:write` | Create a scheduled fiat purchase plan |
| `GET` | `/api/v1/fiat/purchase-plans` | Auth | List caller's purchase plans |
| `GET` | `/api/v1/fiat/purchase-plans/:id` | Auth | Fetch a single purchase plan (owner-scoped) |
| `PATCH` | `/api/v1/fiat/purchase-plans/:id` | `fiat:write` | Update amount, cadence, slippage, payment ref, or pause/resume |
| `DELETE` | `/api/v1/fiat/purchase-plans/:id` | `fiat:write` | Cancel a purchase plan (`status = CANCELLED`) |
| `GET` / `POST` | `/api/v1/fiat/purchase-plans/:id/preview` | Auth | Project next `N` runs with live best-execution quote & fees |
| `GET` | `/api/v1/fiat/purchase-plans/:id/runs` | Auth | Paginated `FiatPurchasePlanRun` history |

---

## 5. Operational Runbook for Stuck Runs

### Case A: Run stuck in `action_required`
- **Automatic handling**: `sweepInFlightPlanRuns()` fails any `action_required` run older than `FIAT_PURCHASE_ACTION_TIMEOUT_MS` (24h) with `failureReason = "3DS_ACTION_TIMEOUT"`.
- **Operator action**: User can trigger a fresh occurrence or update their `paymentMethodRef` via `PATCH /api/v1/fiat/purchase-plans/:id`.

### Case B: Run stuck in `awaiting_settlement`
- **Automatic handling**: `sweepInFlightPlanRuns()` force-fails runs stuck in `awaiting_settlement` past `FIAT_PURCHASE_SETTLEMENT_TIMEOUT_MS` (48h) with `failureReason = "SETTLEMENT_TIMEOUT"` and emits a critical operational alert (`fiat-purchase:stuck:<runId>`).
- **Operator action**: Verify the underlying `fiatOrderId` in `fiat_orders`. If the provider settled on-chain under a mismatched hash, reconcile via `reconcileSingleOrder(orderId, txHash)`.

### Case C: Run in `completed_deposit_pending`
- **Meaning**: The user's card was charged and crypto arrived on-chain (`FiatOrder.status = SETTLED`), but the automatic vault deposit (`executeDeposit`) failed.
- **Operator action**: Never re-run the fiat order. The user can manually deposit the settled wallet balance via `POST /api/v1/deposit`, or an operator can inspect the `failureReason` on the `FiatPurchasePlanRun` row.
