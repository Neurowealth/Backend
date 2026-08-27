# Approval Workflows & Multi-Signature Governance

Closes the gap between "requested" and "executed" for high-value or sensitive
operations (#314). Today a user — or a parent acting through a sub-account —
can move funds with zero friction and zero oversight. An `ApprovalPolicy` lets
a principal require `minApprovers` independent co-signers before an operation
above `highValueThreshold` (or every operation, if the threshold is null) is
allowed to submit on-chain.

## Data model

| Model             | Meaning                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ApprovalPolicy`  | Governs one `SubAccountPermission` (`WITHDRAW`/`DEPOSIT`/`MANAGE_STRATEGY`) for a principal's own account (`scopedToChildUserId = null`) or a specific sub-account relationship (`scopedToChildUserId` = the child). |
| `ApprovalRequest` | One held operation. Snapshots `minApprovers` from the policy at request time and carries the exact operation to (re-)run as `payload`. Status machine below.                                                         |
| `Approval`        | One approver's decision. `@@unique([requestId, approverUserId])` is the concurrency primitive — see below.                                                                                                           |

Status machine: `PENDING → APPROVED → EXECUTED` (terminal — on-chain finality,
never un-executed), or `PENDING → REJECTED / EXPIRED / CANCELLED`.

## Policy resolution

| Caller                                                                 | Resolves                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Self (`actingAsUserId === userId`)                                     | `principalUserId = userId`, `scopedToChildUserId = null`                                    |
| Parent acting on a child (delegated via `requireSubAccountPermission`) | `principalUserId = actingAsUserId` (the parent), `scopedToChildUserId = userId` (the child) |

Pending requests follow the **policy snapshot at request time**
(`minApprovers` is copied onto the row). Editing or deactivating a policy
never changes an already-open request — only new requests see the change.

## Eligible approvers

The issue's schema has no separate "approver list" field. This
implementation reuses the existing `SubAccount` graph as the approver pool:
**the policy owner (`principalUserId`) plus every ACTIVE child under that
same parent** — so "the parent and a child, or two children" can co-sign an
operation on a shared vault, per the issue's example, with no schema change.

**Self-approval**: the requester (`ApprovalRequest.actingAsUserId`) never
counts toward the threshold when `minApprovers > 1` — hard rule, no
per-policy opt-in in v1 (issue's documented default).

**Approver eligibility is checked live**, at decision time, against the
current `SubAccount` state — not the policy snapshot. If a family member's
access was revoked between the request being opened and them approving it,
they can no longer approve. An approval already recorded before revocation
still counts toward the threshold (the issue's recommended "count it, the
policy snapshot is the request's" option) — decisions are never retroactively
invalidated once persisted.

## Enforcement in the money path

`guardOperation` is called from **inside** `executeDeposit` and
`executeWithdraw` (`src/controllers/transaction-controller.ts`), not from
routes — so every caller that reuses those functions is covered by
construction:

- `POST /api/v1/withdraw`, `POST /api/v1/deposit` (HTTP)
- `src/jobs/recurringDeposits.ts` (calls `executeDeposit` directly)

When gated, no `Transaction` row is created yet — the `ApprovalRequest.payload`
holds the exact operation, re-run through the same `executeDeposit`/
`executeWithdraw` path on approval (`skipApprovalGuard: true`, set only by
`src/approvals/executors.ts`, so the approved re-run can't re-gate itself).
The resulting `Transaction`'s memo is tagged `(approval:<requestId>)` and
`ApprovalRequest.executedTxId` links back to it, for audit and the tax report.

**Recurring deposits** treat `PENDING_APPROVAL` as _skip, not fail_:
`lastRunStatus` is set to `pending_approval`, `nextRunAt` is left untouched,
and `guardOperation`'s dedupe check (an existing PENDING request for the same
policy/user/amount) means the next sweep lands on the same open request
instead of creating a new one every tick.

### Scoped out of v1 (documented, not silently dropped)

- **The agent rebalance loop** (`src/agent/loop.ts` →
  `executeRebalanceIfNeeded`) is not gated. Rebalances move funds
  protocol-to-protocol _inside_ the vault (same asset, same user, no
  egress) — the same category the tax report already excludes from
  disposals — not a withdraw/deposit call. `ApprovalPolicy.permission` still
  accepts `MANAGE_STRATEGY` so a policy row is valid data for a future
  rebalance-gating change; wiring it into the hourly autonomous loop is a
  materially different design problem (a diff-of-allocations, not a single
  amount + payload).
- **Referral payouts** (`src/jobs/referralPayout.ts`) are not gated — they
  are platform-funded credits _to_ the user, not the user moving funds out,
  so they don't fit the delegated-authority threat model this issue is
  scoped to (a compromised session, or an over-permissioned family member,
  draining a vault).

## Concurrency

Every status transition after `PENDING` is a **conditional `updateMany`**
(`where: { id, status: 'PENDING' }`), never read-then-write:

- Two approvals landing simultaneously: `Approval` creation is guarded by the
  `@@unique([requestId, approverUserId])` constraint (a second decision from
  the same approver gets `409`, not silently ignored or double-counted).
- Threshold crossed by two concurrent `decide()` calls: both recompute the
  approval count and both attempt `updateMany(PENDING → APPROVED)`; only one
  `count === 1` — that call proceeds to execute, the other sees `count === 0`
  and returns without executing. **Never double-executes.**
- The expiry sweep batches a single `updateMany` per tick since it has no
  other actor contending for the same PENDING → EXPIRED transition (unlike
  `decide`, which races a concurrent human decision).

If execution throws or the on-chain call fails after the request reaches
`APPROVED`, the request is deliberately **left `APPROVED`**, not silently
reset to `PENDING` or lost — an ops-visible stuck state for retry/
investigation, matching the tax module's "never invert the dependency"
philosophy for money-adjacent bookkeeping.

## Endpoints

```
GET  /api/v1/approvals                    — requests affecting the caller (paginated)
GET  /api/v1/approvals/:id                — full request + decisions
POST /api/v1/approvals/:id/approve        — { note? }
POST /api/v1/approvals/:id/reject         — { reason }  (required)
POST /api/v1/approvals/:id/cancel         — requester only
POST /api/v1/admin/approvals/:id/cancel   — admin (scope: approvals:write)

GET  /api/v1/approval-policies            — policies the caller owns
GET  /api/v1/approval-policies/:id
POST /api/v1/approval-policies            — { scopedToChildUserId?, permission, minApprovers, highValueThreshold?, approvalTimeoutMs }
PUT  /api/v1/approval-policies/:id        — { minApprovers?, highValueThreshold?, approvalTimeoutMs?, isActive? }
```

Creating/editing a policy with `scopedToChildUserId` set requires the caller
to currently hold `MANAGE_STRATEGY` on that child (re-checked on every write,
not just at creation).

## Webhooks

`approval.requested`, `approval.approved`, `approval.rejected`,
`approval.executed`, `approval.expired`, `approval.cancelled` — see
`src/validators/webhook-validators.ts`.

## Known limitations (v1)

1. Agent-loop rebalances and referral payouts are not gated (see above).
2. No per-policy self-approval opt-in — always disallowed when
   `minApprovers > 1`.
3. Approver pool is derived entirely from the `SubAccount` graph; there is no
   standalone "add an approver who isn't a sub-account party" concept.
4. `guardOperation`'s dedupe window is keyed on (policy, user, actingAsUser,
   permission, asset, amount) — two _different_ legitimate operations that
   happen to share every one of those fields within the same open window
   will be treated as the same request.
