# Durable Outbox & Prioritized On-Chain Transaction Queue (#325)

Every on-chain money movement — a user deposit or withdrawal, an agent
rebalance, a referral reward payout — used to be fire-and-forget from the
caller's perspective: build a Stellar operation, submit it, handle failure
locally. There was no shared, durable record of intent that survives a crash
or a mid-flight RPC timeout, no global ordering or prioritization, and no
fee-bumping strategy under network congestion.

This adds a durable outbox + prioritized dispatcher — the single choke point
every on-chain write passes through — so a money move is atomic (the intent
and the business state that caused it commit or roll back together),
retriable, priority-ordered, and observable.

## The state machine

```
                    ┌────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
 enqueue ──────► PENDING ──────claim──────► SUBMITTED ──────► │ (backoff retry)
 (in a DB tx)       │                          │  │
                    │                          │  └────success────► CONFIRMED (terminal)
                    │                          │
                cancel (admin,             exhausted attempts /
                unsent only)               fee-bump cap reached
                    │                          │
                    ▼                          ▼
                CANCELLED (terminal)        FAILED (terminal) ◄── admin force-retry ──► PENDING
```

| Status | Meaning |
| --- | --- |
| `PENDING` | Durable intent persisted; not yet claimed, or returned here after a retriable failure (with `nextAttemptAt` backoff) |
| `SUBMITTED` | Claimed by a dispatcher and mid-flight; carries `signerPublicKey` and an incremented `attempts` |
| `CONFIRMED` | On-chain success observed (terminal) |
| `FAILED` | Exhausted retries, a non-retriable on-chain rejection, or the fee-bump cap was reached (terminal; full error + attempt count retained for audit) |
| `CANCELLED` | Admin-cancelled while still unsent (terminal) |

The pure rules — legal transitions and priority ordering — live in
`src/outbox/stateMachine.ts` with no I/O, so they are unit-tested directly
(`tests/unit/outbox/stateMachine.test.ts`) without a database.

## Priority & ordering

```ts
CRITICAL // user withdrawals — capital leaving the platform
NORMAL   // deposits, recurring deposits, referral rewards
LOW      // agent-triggered rebalances
```

The dispatcher claims `PENDING` ops ordered by priority, then FIFO
(`createdAt`) within a tier. A CRITICAL withdrawal never waits behind a wave
of NORMAL or LOW ops queued ahead of it, however large — see
`src/outbox/stateMachine.ts#compareForDispatch` and the starvation tests in
`tests/unit/outbox/stateMachine.test.ts`.

## Idempotency

`idempotencyKey = "<kind>:<userId>:<businessRecordId>"`
(`src/outbox/idempotency.ts`), where `businessRecordId` is the row this op is
the durable intent for — a `Transaction.id` for DEPOSIT/WITHDRAW/REBALANCE, a
`"<conversionId>:<leg>"` pair for REFERRAL_REWARD. `enqueueOutboxOp` is an
upsert by this key: re-running a caller against the same business record
(a retried job tick, a crash-and-restart) resolves to the same op row instead
of creating a duplicate.

## Atomic claim (no double-submission)

Claiming is a single conditional update:

```sql
UPDATE outbox_ops SET status = 'SUBMITTED', attempts = attempts + 1, ...
WHERE id = $1 AND status = 'PENDING'
```

Exactly one caller ever sees `count = 1`; every other concurrent claim
attempt for the same op sees `count = 0` and treats it as a no-op
(`src/outbox/service.ts#claimOp`). This is what makes it safe for a
synchronous request handler and the background sweep to race for the same op
— see `tests/integration/outbox/dispatcher.integration.test.ts`.

## Retry, backoff, and fee-bump

- **Transient submit failure** (a thrown exception — network error, RPC
  timeout, simulation failure): the op returns to `PENDING` with a
  full-jitter exponential backoff `nextAttemptAt`
  (`src/outbox/stateMachine.ts#computeBackoffMs`, bounded by
  `OUTBOX_BACKOFF_BASE_MS`/`OUTBOX_BACKOFF_MAX_MS`). After
  `OUTBOX_MAX_ATTEMPTS` the op moves to `FAILED`.
- **Non-retriable on-chain rejection** (the submission resolves with
  `status: 'failed'` rather than throwing — e.g. a vault-contract
  precondition failure): recorded as `FAILED` immediately, not retried. This
  matches the single-attempt behavior the deposit/withdraw routes had before
  this change.
- **Unconfirmed too long** (`SUBMITTED` past `OUTBOX_SUBMITTED_TIMEOUT_MS`,
  typically because the dispatcher process crashed between submitting and
  observing its own confirmation, or the network is congested): escalated
  back to `PENDING` for reclaim; the next submission uses a bumped fee
  (`feeBumpMultiplier ^ attempts`, via `src/stellar/contract.ts`'s
  `feeMultiplier` parameter on every write call). After
  `OUTBOX_FEE_BUMP_MAX_ATTEMPTS` bumps, the op is escalated straight to
  `FAILED` with the full attempt history preserved.

All of the above is driven by `src/outbox/dispatcher.ts#runDispatchSweep`,
scheduled every `OUTBOX_DISPATCH_INTERVAL_MS` (default 15s).

## Confirmation oracle

Two paths close an op out to `CONFIRMED`:

1. **The dispatcher's own submission.** `executeOutboxPayload` (via
   `src/stellar/contract.ts`) already waits for on-chain confirmation before
   resolving, so in the normal case the same call that submits also confirms.
2. **The event listener, as a fallback.** `src/stellar/events.ts` calls
   `reconcileOutboxOpByTxHash` on the same DB transaction that confirms a
   `Transaction` row by `txHash`. This closes out a `SUBMITTED` op left
   behind by a dispatcher crash between submission and its own confirmation
   — the event listener remains the durable source of truth, matching the
   existing `ProcessedEvent`/`DeadLetterEvent` design.

For a synchronous caller (deposit, withdraw, referral payout), the linked
`Transaction` row is updated directly after `dispatchOne` resolves. For the
one genuinely non-blocking path — an agent rebalance, enqueued via
`dispatchInBackground` and never awaited by the loop — nobody would otherwise
update that row, so `src/outbox/dispatcher.ts#submitClaimedOp` mirrors the
final outcome onto it directly via `mirrorLinkedTransaction`
(`transactionId` carried in the payload). This also covers the general
crash-recovery case: if the original synchronous caller already returned
(possibly with an error) before the background sweep independently resubmits
and confirms the same op, the Transaction row still gets updated.

## Per-signer serialization & concurrency caps

The custodial/agent wallet submits transactions using that account's Stellar
sequence number: two ops signed by the same key must never be in flight at
once. `src/outbox/signerLock.ts` is an in-process mutex keyed by
`signerPublicKey`, plus a global and a per-account cap
(`OUTBOX_GLOBAL_MAX_IN_FLIGHT`, `OUTBOX_PER_ACCOUNT_MAX_IN_FLIGHT`, default
`1` — i.e. strictly serial per signer). This is sufficient for a single
dispatcher process; the atomic claim above is what would make running more
than one dispatcher process safe, but that configuration is out of scope for
this change.

## Compliance halt guard

Before dispatching any op, `src/outbox/service.ts#isUserHalted` checks
`User.isActive` — the same field `src/middleware/authenticate.ts` already
checks to reject a frozen user's session. A user frozen after their op was
already queued has that op skipped on every sweep until they are reactivated;
new requests from a frozen user are already rejected at the route layer.

## Caller migration

| Path | Kind | Priority | Dispatch |
| --- | --- | --- | --- |
| `POST /deposit`, `POST /withdraw` (`src/controllers/transaction-controller.ts`) | DEPOSIT / WITHDRAW | NORMAL / CRITICAL | Enqueued transactionally with the `Transaction` row, then dispatched inline and awaited — the HTTP response contract (`201`, synchronous `CONFIRMED`/`FAILED`) is unchanged from before this PR |
| Recurring deposits (`src/jobs/recurringDeposits.ts`) | DEPOSIT | NORMAL | Shares `executeDeposit` with the HTTP path — gets outbox durability for free |
| Referral payouts (`src/referral/service.ts#payOneReward`) | REFERRAL_REWARD | NORMAL | Enqueued transactionally, dispatched inline and awaited (the sweep already processes conversions serially) |
| Agent rebalance (`src/agent/router.ts#triggerRebalance`) | REBALANCE | LOW | Enqueued transactionally, then `dispatchInBackground` — **not awaited**. The loop moves to the next batch immediately; the background sweep (or the opportunistic in-process attempt) submits it on its own cadence |

No code path outside `src/stellar/contract.ts` (which defines the raw write
functions) and `src/outbox/executors.ts` (the one place that calls them) may
import `depositForUser`, `withdrawForUser`, `triggerRebalance`, or
`payReferralReward` — enforced by
`tests/unit/outbox/structural.test.ts`, which fails CI the moment a new money
path bypasses the outbox.

## Admin API

All under `/api/admin/outbox`, scoped keys (`outbox:read` / `outbox:write`),
fully `AdminAuditLog`-audited (`src/routes/admin.ts`):

| Endpoint | Scope | Purpose |
| --- | --- | --- |
| `GET /api/admin/outbox` | `outbox:read` | List/query ops — filter by `status`, `kind`, `priority`, `userId` |
| `GET /api/admin/outbox/stats` | `outbox:read` | Queue depth grouped by status/priority |
| `GET /api/admin/outbox/:id` | `outbox:read` | Inspect a single op |
| `POST /api/admin/outbox/:id/retry` | `outbox:write` | Force a `FAILED` op back to `PENDING`, clearing backoff |
| `POST /api/admin/outbox/:id/cancel` | `outbox:write` | Cancel an unsent op — `PENDING` only; a `SUBMITTED` op is already on-chain and cannot be cancelled |

## Metrics (`src/utils/metrics.ts`)

| Metric | Type | Labels |
| --- | --- | --- |
| `outbox_ops_total` | Counter | `kind`, `priority`, `outcome` (`confirmed`\|`retry`\|`failed`) |
| `outbox_queue_depth` | Gauge | `status`, `priority` |
| `outbox_op_latency_seconds` | Histogram | `kind` — creation to confirmation |
| `outbox_fee_bump_total` | Counter | `kind` |
| `outbox_stuck_submitted` | Gauge | — ops `SUBMITTED` past the timeout; the "lost in flight" alarm |
| `fee_oracle_recommended_base_fee` | Gauge | — current p70 |
| `fee_oracle_aggressive_base_fee` | Gauge | — current p95 |
| `fee_oracle_ledger_capacity_usage` | Gauge | — 0..1 |
| `fee_oracle_congestion_level` | Gauge | — 0=low,1=elevated,2=high,3=severe |
| `fee_oracle_staleness_seconds` | Gauge | — seconds since last good sample |
| `fee_oracle_clamp_total` | Counter | `bound` (`min`\|`max`) |
| `outbox_low_deferred_total` | Counter | — LOW deferred due to high congestion |
| `outbox_aggressive_fee_used_total` | Counter | — CRITICAL used aggressive fee |
| `outbox_max_fee_hit_total` | Counter | `priority` |

## Configuration (`src/config/env.ts` → `config.outbox`)

| Env var | Default | Meaning |
| --- | --- | --- |
| `OUTBOX_DISPATCH_INTERVAL_MS` | `15000` | Background sweep cadence |
| `OUTBOX_MAX_ATTEMPTS` | `5` | Attempts before a transient failure gives up (→ `FAILED`) |
| `OUTBOX_BACKOFF_BASE_MS` / `OUTBOX_BACKOFF_MAX_MS` | `2000` / `120000` | Full-jitter backoff bounds |
| `OUTBOX_SUBMITTED_TIMEOUT_MS` | `90000` | How long `SUBMITTED` may sit unconfirmed before fee-bump escalation |
| `OUTBOX_FEE_BUMP_MULTIPLIER` | `2` | Fee multiplier per bump (compounds) |
| `OUTBOX_FEE_BUMP_MAX_ATTEMPTS` | `3` | Fee-bump cap before a stuck op is escalated to `FAILED` |
| `OUTBOX_MAX_ABS_FEE` | `100000` | Absolute fee cap in stroops |
| `OUTBOX_LOW_DEFER_MS` | `15000` | LOW defer interval during high congestion |
| `OUTBOX_LOW_MAX_DEFER_MS` | `300000` | Max total defer for a LOW op |
| `OUTBOX_GLOBAL_MAX_IN_FLIGHT` | `10` | Global in-flight cap |
| `OUTBOX_PER_ACCOUNT_MAX_IN_FLIGHT` | `1` | Per-signer in-flight cap (serial per account) |
| `OUTBOX_BATCH_SIZE` | `20` | Ops claimed per sweep |
| `FEE_ORACLE_POLL_MS` | `10000` | Fee oracle poll cadence |
| `FEE_ORACLE_TTL_MS` | `30000` | Snapshot TTL |
| `FEE_ORACLE_MIN` | `100` | Min base fee (stroops) |
| `FEE_ORACLE_MAX` | `50000` | Max base fee (stroops) |
| `FEE_ORACLE_DEFAULT_BASE_FEE` | `100` | Fallback base fee |

## Fee oracle & congestion policy (#342)

The outbox no longer sets fees blindly and bumps only after failure.

### Fee oracle (`src/stellar/feeOracle.ts`)

A small service that polls `server.getFeeStats()` and `server.getLatestLedger()` every `FEE_ORACLE_POLL_MS` (default 10s) via the resilient RPC client, keeps a short in-memory history (and a Redis-mirrored snapshot at `fee-oracle:snapshot`), and publishes:

```ts
FeeSnapshot {
  recommendedBaseFee: number   // p70 inclusion fee, floored 100 stroops
  aggressiveBaseFee: number    // p95, for CRITICAL ops
  congestionLevel: 'low'|'elevated'|'high'|'severe'
  ledgerCapacityUsage: number  // 0..1
  sampledAt: string
  ttlMs: number
}
```

`congestionLevel` is derived from `ledgerCapacityUsage` and the `min→p95` spread, with hysteresis and a 30s dwell so a single noisy sample does not flap. Recommended/aggressive fees are clamped to `[FEE_ORACLE_MIN, FEE_ORACLE_MAX]` (`100`–`50000` stroops) and floored at `100`. On poll failure the snapshot goes stale; consumers fall back to `FEE_ORACLE_DEFAULT_BASE_FEE` (100) and staleness is a metric + `fee-oracle:stale` alert. `ttlMs` (default 30s) is evaluated on the consumer clock with 1s grace. Redis absence is logged, not fatal — in-memory still serves.

### Dispatcher integration

`submitClaimedOp` reads the current snapshot before the first attempt:

*   `NORMAL` (deposits): `recommendedBaseFee`
*   `LOW` (rebalances): `recommendedBaseFee`, but if `congestionLevel >= high` the op is **deferred** — left `PENDING` with `nextAttemptAt = now + OUTBOX_LOW_DEFER_MS` (default 15s), bounded by `OUTBOX_LOW_MAX_DEFER_MS` (default 5m) after which it dispatches regardless (a rebalance is never cancelled, only delayed). Counter `outbox_low_deferred_total`.
*   `CRITICAL` (withdrawals): `aggressiveBaseFee` when `congestionLevel >= elevated`, otherwise `recommendedBaseFee`. Never waits. Counter `outbox_aggressive_fee_used_total`.

Per-attempt `computeFeeMultiplier` still compounds on top (`feeBumpMultiplier ** min(attempts-1, feeBumpMaxAttempts)`), but the product `baseFee * multiplier` is now capped by an **absolute** `OUTBOX_MAX_ABS_FEE` (default 100000 stroops) so a high oracle base cannot compound without bound. Hitting the cap on a `CRITICAL` op still submits at the cap and emits a critical `outbox:max-fee-hit` alert (`outbox_max_fee_hit_total{priority}`).

`reconcileStuckSubmitted` uses the *current* oracle base for its fee-bump resubmission, not a multiple of the original.

### API surface

*   `GET /api/v1/network/conditions` (public, rate-limited) → current `FeeSnapshot` + per-priority `etaBands` derived from `outbox_op_latency_seconds` percentiles.
*   `POST /api/v1/deposit` and `POST /api/v1/withdraw` responses now include `estFee` (stroops) and `estConfirmationSeconds` from the oracle.

### Telemetry

Gauges `fee_oracle_recommended_base_fee`, `fee_oracle_aggressive_base_fee`, `fee_oracle_ledger_capacity_usage`, `fee_oracle_congestion_level` (0..3), `fee_oracle_staleness_seconds`; counters `fee_oracle_clamp_total{bound}`, `outbox_low_deferred_total`, `outbox_aggressive_fee_used_total`, `outbox_max_fee_hit_total{priority}`. Grafana `latency` dashboard panel + alerts `oracle stale > N s`, `severe > M min`.

## Out of scope

- Multi-signer/HSM signing infrastructure — the dispatcher stays on the
  existing agent-signed / custodial-user-signed path.
- Cross-chain submission — Stellar-only; `src/outbox/executors.ts` is the
  intended seam for adding another chain's executor later.
- Replacing the event listener as confirmation source of truth.
- Running more than one dispatcher process — the atomic claim would make it
  safe, but the in-process signer mutex would not coordinate across
  processes without an additional distributed lock.
