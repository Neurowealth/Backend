# Explainable Rebalancing — Decision Rationale Ledger (#343)

Every automated money movement now leaves a structured, durable `RebalanceDecision` row that explains *why it happened and why then*, so a user, an auditor, or a support engineer can reconstruct the decision after the fact.

## Model — `RebalanceDecision`

One row per `protocol:strategy:followId` batch evaluation per tick, whether or not a rebalance fired:

```
RebalanceDecision {
  id, correlationId, batchKey,
  fromProtocol, toProtocol,           // toProtocol null when the decision was "hold"
  outcome         REBALANCED | HELD | BLOCKED
  blockedReason   risk_ceiling | below_min_improvement | cost_exceeds_gain | no_candidates | null
  strategyName, strategyIsFollowed, followedStrategyId
  thresholds      { minimumImprovement, maxGasPercent }   // snapshot at decision time
  currentApy, chosenApy, rawImprovement, estCostPercent, netImprovement  // Decimal(12,6)
  candidates      [{ protocol, apy, riskScore, eligible, rejectionReason }]
  rationale       String?   // server-templated, never free-form user text
  affectedUserIds String[]  // every user whose position was in the batch
  affectedPositions Int
  outboxOpId      String?   // links the decision to the durable outbox op when one was enqueued
  heldSince, lastEvaluatedAt   // window for consecutive identical HELD collapsing
  createdAt
}
```

`candidates` is the full ranked protocol list. Each non-winner carries `rejectionReason`:

- `lower_apy` / `lower_target_weight` — eligible but lost on yield/weight,
- `over_risk_ceiling` — score present but below ceiling,
- `risk_score_unknown` — fail-closed when absent from the risk-score map.

Thresholds are snapshotted into the row so a later config change never rewrites what the agent actually used.

## Persistence — best-effort, never blocks a rebalance

`src/agent/rebalanceDecision.ts#persistRebalanceDecision` is the single writer. Failures are `logger.error` + `alertingService.emit` (`agent:decision-persist:<batchKey>:<outcome>`) and return `null`; the rebalance itself never rolls back. Decisions are backfillable from the correlation-scoped logs (same pattern as tax-lot creation in `src/stellar/events.ts`).

### Consecutive-HELD collapsing

A batch that holds every tick would otherwise write 24 rows/day/batch. Consecutive identical `HELD` decisions for the same `batchKey` — same `candidates` ranking and same `thresholds` (canonicalized via `audit/chain#canonicalizeAuditPayload`) — collapse into one row: the existing row's `lastEvaluatedAt` is bumped and `affectedUserIds` is union-merged; a change in inputs starts a new row (`heldSince` marks the window start).

## Audit-ledger feed (#315)

Each **new** decision row's canonical payload is hashed via `audit/chain#auditPayloadHashFor` and inserted into `audit_payload_hashes` (`tableName=rebalance_decisions`, `kind=REBALANCE_DECISION`). The row hash is the per-decision contribution to the hash-chained audit ledger; the ledger's chain verification (`audit/chain#verifyAuditChain`) therefore covers every decision.

## Real-time — `agent.decision_recorded`

On every new decision row, `agent.decision_recorded` is published to each affected user's stream (`publishUserEvent` with `EVENT_TYPE_TOPIC['agent.decision_recorded'] = 'agent'`):

```
{ decisionId, outcome, fromProtocol, toProtocol, blockedReason, createdAt }
```

Allowlisted in `utils/api-formatters#USER_EVENT_PAYLOAD_ALLOWLIST` so only those keys reach the client. The `agent.rebalanced` event is still emitted per-batch as before; `agent.decision_recorded` arrives right after it so a dashboard can deep-link to `/api/v1/agent/decisions/:id` without polling.

## API

### User — owner-scoped via `affectedUserIds`

```
GET /api/v1/agent/decisions
  ?outcome=REBALANCED|HELD|BLOCKED
  &fromProtocol=Blend
  &from=2026-08-10T00:00:00Z
  &to=2026-08-11T00:00:00Z
  &page=1&limit=10
```

Paginated `findMany` where `affectedUserIds has <callerId>`, ordered `createdAt desc`. Filterable by `outcome`, `fromProtocol`, and a `createdAt` date range. Response is projected per-user: `affectedUserIds` is stripped (no sibling userIds leak) and `affectedPositions` is batch-level (not per-user size); `candidates` and apy/threshold fields are batch-level.

```
GET /api/v1/agent/decisions/:id
```

The same `affectedUserIds has <callerId>` guard, but returns the full trace (ranked `candidates`, thresholds, the `rationale`, and — when the decision linked an `outboxOpId` — the current outbox `status` so the UI can show “decided to rebalance → on-chain submission failed”).

#### Per-user projection

- No field from another user's position is echoed: only protocol names, public APYs, public risk scores, and the batch decision.
- Followed-strategy privacy: `followedStrategyId` (the publisher's `PublishedStrategy.id`) is shown to the follower; the publisher's userId and other followers are never exposed.
- Outbox op later fails: `RebalanceDecision.outcome` stays `REBALANCED`; the API joins `outboxOpId` to `outbox_ops.status` so the UI can explain the discrepancy.

### Admin — unrestricted, audit-logged

```
GET /api/v1/admin/agent/decisions
  ?outcome=&fromProtocol=&from=&to=&correlationId=&batchKey=&page=&limit=
  — requires `read` scope (admin-scoped), written to `AdminAuditLog` as `LIST_AGENT_DECISIONS`.
```

Returns every row (no `affectedUserIds` filter) with `affectedUserIds + affectedPositions` included for support/audit. No user projection, no stripping.

## Strategy plumbing

`src/agent/strategies.ts#rankCandidates` builds `RankedCandidate[]` from the ordered protocol list the strategy actually evaluated. Each strategy decision now carries `candidates` and — for non-rebalances — `blockedReason` so the ledger doesn't need to string-match `reasoning`:

- `risk_ceiling` — ceiling excluded every candidate,
- `below_min_improvement` — net improvement below the effective threshold,
- `cost_exceeds_gain` — payback gate rejected the move,
- `no_candidates` — no protocols available / no APY,
- (internal) `exposure_unplaceable` — caps summed below 100% (if seen, surfaced as `no_candidates` in the strategy path).

`src/agent/router.ts#compareProtocols` now returns `ProtocolComparison.trace` (candidates + `cost.breakdown` + thresholds + APYs) instead of only logging it. The strategy engine returns `candidates` alongside its `reasoning`. `src/agent/router.ts#executeRebalanceIfNeeded` persists a decision for every outcome (REBALANCED/HELD/BLOCKED), best-effort, and links `outboxOpId` when it enqueues.

## Backfill

Historical rebalances are not backfilled; only prospective decisions are recorded (#343 is forward-only).
