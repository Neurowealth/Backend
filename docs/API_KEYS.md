# User API Keys (#374)

Scoped, long-lived credentials for programmatic access to a user's own account.

## Key format

```
nwk_<keyId>_<secret>
```

The raw token is shown **once** at creation or rotation. It is stored as a bcrypt hash with a SHA-256 `tokenPrefix` for fast lookup (mirrors `AdminApiKey`).

## Authentication

```http
Authorization: Bearer nwk_<keyId>_<secret>
```

API keys authenticate via the same `requireAuth` entry point as session JWTs. The middleware detects the `nwk_` prefix and routes to the dedicated API-key path.

## Scopes

Every scope is described in a machine-readable catalogue
(`src/auth/scopes.ts` for user keys, `src/middleware/adminAuth.ts` for admin
keys). `GET /api/admin/keys/scopes` serves it for the key-creation UI, and
the tables below are generated from it — `tests/unit/auth/scopeCatalog.test.ts`
fails CI if the catalogue, the call sites and this document disagree.

The **Enforcement** column says whether the scope actually gates anything:

| Enforcement | Meaning |
| --- | --- |
| `enforced` | At least one route requires it. Granting it is meaningful; omitting it is restrictive. |
| `declared-only` | Declared and reservable, but no route requires it today — granting it currently grants nothing extra. |

The **Implies** column lists the scopes a scope grants on its own. `super`
implies every admin scope, and the legacy `agent` implies `agent:read` and
`agent:write`.

### User key scopes

<!-- BEGIN GENERATED: user-scope-catalog -->
| Scope | Risk | Enforcement | Implies | What it does | Guardrail | Endpoints |
| --- | --- | --- | --- | --- | --- | --- |
| `loans:read` | read | enforced | — | Read loan state and borrowing capacity. | — | `GET /api/v1/loans`, `GET /api/v1/loans/:loanId`, `GET /api/v1/loans/capacity` |
| `portfolio:read` | read | enforced | — | Read portfolio positions, balances, history, earnings and tax reports. | — | `GET /api/v1/portfolio/:userId`, `GET /api/v1/portfolio/:userId/earnings`, `GET /api/v1/portfolio/:userId/history`, `GET /api/v1/portfolio/:userId/suggestions`, `GET /api/v1/portfolio/:userId/tax-report` |
| `transactions:read` | read | enforced | — | Read transaction history. | — | `GET /api/v1/transactions/:id/events`, `GET /api/v1/transactions/:userId`, `GET /api/v1/transactions/detail/:txHash` |
| `vault:read` | read | enforced | — | Read vault state and balance. | — | `GET /api/v1/vault/balance` |
| `alerts:manage` | write | enforced | — | Manage alert rules. | — | `DELETE /api/v1/alerts/:id`, `PATCH /api/v1/alerts/:id`, `POST /api/v1/alerts`, `POST /api/v1/alerts/:id/restore` |
| `goals:write` | write | enforced | — | Manage savings goals. | — | `DELETE /api/v1/portfolio/goals/:id`, `PATCH /api/v1/portfolio/goals/:id`, `POST /api/v1/portfolio/goals` |
| `portfolio:write` | write | enforced | — | Change portfolio state. | — | `DELETE /api/v1/net-worth/external-wallets/:id`, `POST /api/v1/net-worth/external-wallets` |
| `strategies:write` | write | enforced | — | Publish, follow and unfollow strategies. | — | `POST /api/v1/strategies/publish` |
| `webhooks:manage` | write | enforced | — | Manage webhook endpoints and deliveries. | — | `DELETE /api/webhooks/:id`, `PATCH /api/webhooks/:id`, `POST /api/webhooks` |
| `deposit:write` | money | enforced | — | Create deposits. | Deposits still pass the compliance freeze and sub-account permission checks. | `POST /api/v1/deposit` |
| `fiat:write` | money | enforced | — | Create fiat on/off-ramp orders. | — | `POST /api/v1/fiat/orders` |
| `loans:write` | money | enforced | — | Originate and repay collateral loans. | Origination and repayment still pass the compliance freeze and sub-account permission checks. | `POST /api/v1/loans`, `POST /api/v1/loans/:loanId/repay` |
| `recurring_deposits:write` | money | enforced | — | Manage recurring deposit plans. | — | `DELETE /api/v1/deposit/recurring/:id`, `PATCH /api/v1/deposit/recurring/:id`, `POST /api/v1/deposit/recurring` |
| `vault:write` | money | enforced | — | Build vault transactions. | — | `POST /api/v1/vault/build-transaction` |
| `withdraw:write` | money | enforced | — | Create withdrawals. | Requires allowWithdrawals on the key AND the platform kill-switch USER_API_KEY_WITHDRAWALS_ENABLED to be on. | `DELETE /api/v1/recurring-withdrawals/:id`, `PATCH /api/v1/recurring-withdrawals/:id`, `POST /api/v1/recurring-withdrawals`, `POST /api/v1/withdraw` |
<!-- END GENERATED: user-scope-catalog -->

New keys are **read-only by default**. Write scopes must be explicitly requested.

### Admin key scopes

<!-- BEGIN GENERATED: admin-scope-catalog -->
| Scope | Risk | Enforcement | Implies | What it does | Guardrail | Endpoints |
| --- | --- | --- | --- | --- | --- | --- |
| `agent:read` | read | enforced | — | Read agent decisions and circuit-breaker state. | — | `GET /api/v1/admin/agent/breakers`, `GET /api/v1/admin/agent/decisions` |
| `dlq:read` | read | enforced | — | Inspect the dead-letter queue. | — | `GET /api/v1/admin/dlq/inspect`, `GET /api/v1/admin/notifications/dlq` |
| `erasure:read` | read | declared-only | — | Preview what an erasure would delete. | No route requires this scope today — the erasure preview route is gated by the generic read scope. Declared so a key can be provisioned ahead of a route that needs it. | — |
| `fiat:read` | read | enforced | — | Read fiat providers and their health. | — | `GET /api/v1/admin/fiat/providers` |
| `flags:read` | read | enforced | — | Read feature flags and rollout state. | — | `GET /api/v1/admin/feature-flags`, `GET /api/v1/admin/feature-flags/:key`, `GET /api/v1/admin/feature-flags/history` |
| `keys:read` | read | enforced | — | Read admin API keys and wallet rotation status. | — | `GET /api/v1/admin/keys`, `GET /api/v1/admin/wallets/rotation-status` |
| `messages:read` | read | enforced | — | Read message delivery state. | — | `GET /api/v1/admin/messages`, `GET /api/v1/admin/messages/:id`, `GET /api/v1/admin/messages/stats` |
| `metrics:read` | read | enforced | — | Read operational metrics and dashboards. | — | `GET /api/v1/admin/jobs/dashboard`, `GET /api/v1/admin/stellar/metrics` |
| `outbox:read` | read | enforced | — | Read the durable outbox. | — | `GET /api/v1/admin/outbox`, `GET /api/v1/admin/outbox/:id`, `GET /api/v1/admin/outbox/stats` |
| `read` | read | enforced | — | General read access to admin resources. | — | `GET /api/v1/admin/erasure/preview/:userId`, `GET /api/v1/admin/erasure/requests`, `GET /api/v1/admin/referrals/review` |
| `referrals:read` | read | enforced | — | Read flagged referral conversions. | — | `GET /api/v1/admin/referrals/flagged`, `GET /api/v1/admin/referrals/fraud/calibration`, `GET /api/v1/admin/referrals/fraud/queue` |
| `reserves:read` | read | enforced | — | Read reserve and sponsorship state. | — | `GET /api/v1/admin/reserves` |
| `risk-metadata:read` | read | enforced | — | Read protocol risk metadata. | `GET /api/v1/admin/risk-metadata` lists entries with a stale flag. | `GET /api/v1/admin/risk-metadata` |
| `sessions:read` | read | enforced | — | Read user sessions. | — | `GET /api/v1/admin/users/:id/sessions` |
| `support:read` | read | enforced | — | Read support tickets. | — | `GET /api/v1/admin/support/tickets`, `GET /api/v1/admin/support/tickets/:id` |
| `treasury:read` | read | enforced | — | Read treasury sweep policies. | — | `GET /api/v1/admin/treasury/policies`, `POST /api/v1/admin/treasury/sweep/preview` |
| `approvals:write` | write | enforced | — | Cancel pending approval requests. | — | `POST /api/v1/admin/approvals/:id/cancel` |
| `sessions:write` | write | enforced | — | Revoke user sessions. | — | `POST /api/v1/admin/users/:id/sessions/revoke-all` |
| `support:write` | write | enforced | — | Reply to and update support tickets. | — | `PATCH /api/v1/admin/support/tickets/:id`, `POST /api/v1/admin/support/tickets/:id/reply` |
| `write` | write | enforced | — | General write access to admin resources. | — | `POST /api/v1/admin/erasure/requests`, `POST /api/v1/admin/referrals/review/:id/approve`, `POST /api/v1/admin/referrals/review/:id/reject` |
| `outbox:write` | money | enforced | — | Force-retry and cancel queued outbox operations. | — | `POST /api/v1/admin/outbox/:id/cancel`, `POST /api/v1/admin/outbox/:id/retry` |
| `referrals:write` | money | enforced | — | Approve or reject flagged referral conversions. | — | `POST /api/v1/admin/referrals/:id/review`, `POST /api/v1/admin/referrals/fraud/bulk-review` |
| `treasury:write` | money | enforced | — | Change treasury sweep policies and run a sweep. | Sweep policies and signer rotations are written to the admin audit log. | `POST /api/v1/admin/treasury/emergency-sweep`, `POST /api/v1/admin/treasury/policies`, `POST /api/v1/admin/treasury/policies/:id/enable`, `POST /api/v1/admin/treasury/signer-rotations`, `POST /api/v1/admin/treasury/signer-rotations/:id/finalize` |
| `wallet` | money | declared-only | — | Custodial wallet operations. | No route requires this scope today — the wallet rotation-status route is gated by keys:read. Declared so a key can be provisioned ahead of a route that needs it. | — |
| `erasure:write` | destructive | enforced | — | Create, approve, reject and execute erasure requests. | Execution requires super — approval and execution are deliberately separated so one operator cannot both authorise and carry out a deletion. | `POST /api/v1/admin/erasure` |
| `keys:write` | destructive | enforced | — | Create, rotate and revoke admin API keys. | Minting an admin key is a takeover vector — every use is written to the admin audit log. | `DELETE /api/v1/admin/keys/:id`, `POST /api/v1/admin/keys`, `POST /api/v1/admin/keys/:id/rotate` |
| `super` | destructive | enforced | `support:read`, `support:write`, `read`, `write`, `wallet`, `agent`, `agent:read`, `agent:write`, `sessions:read`, `sessions:write`, `reserves:read`, `metrics:read`, `dlq:read`, `dlq:write`, `backfill:write`, `keys:read`, `keys:write`, `fiat:read`, `fiat:write`, `outbox:read`, `outbox:write`, `approvals:write`, `referrals:read`, `referrals:write`, `erasure:write`, `erasure:read`, `flags:read`, `flags:write`, `messages:read`, `messages:write`, `treasury:read`, `treasury:write`, `risk-metadata:read`, `risk-metadata:write`, `admin:impersonate`, `super` | Every admin scope, including erasure execution. | Held by as few keys as possible: it is a superset of every destructive scope in this catalogue. | `GET /api/v1/admin/audit/prove`, `GET /api/v1/admin/audit/verify`, `POST /api/v1/admin/erasure/requests/:id/approve`, `POST /api/v1/admin/erasure/requests/:id/execute`, `POST /api/v1/admin/erasure/requests/:id/reject` |
| `admin:impersonate` | operational | declared-only | — | View the API as a user, read-only. | No route requires this scope today — the impersonation controller exists but is not yet exposed through the admin API. Every impersonated request is attributed to the operator in the admin audit log. | — |
| `agent` | operational | declared-only | `agent:read`, `agent:write` | Agent loop operations. | — | — |
| `agent:write` | operational | enforced | — | Change agent circuit breakers. | — | `POST /api/v1/admin/agent/breakers`, `POST /api/v1/admin/agent/breakers/:id/reset` |
| `backfill:write` | operational | enforced | — | Run Stellar event backfills. | — | `POST /api/v1/admin/stellar/backfill` |
| `dlq:write` | operational | enforced | — | Replay, retry and resolve dead-lettered work. | — | `POST /api/v1/admin/dlq/replay`, `POST /api/v1/admin/dlq/resolve`, `POST /api/v1/admin/dlq/retry`, `POST /api/v1/admin/notifications/dlq/:id/retry` |
| `fiat:write` | operational | enforced | — | Change fiat provider failover state. | — | `POST /api/v1/admin/fiat/providers/:name/failover` |
| `flags:write` | operational | enforced | — | Manage feature flags, staged rollouts and emergency rollbacks. | — | `POST /api/v1/admin/feature-flags/:key/reset`, `POST /api/v1/admin/feature-flags/:key/rollback`, `POST /api/v1/admin/feature-flags/:key/staged-rollout`, `POST /api/v1/admin/feature-flags/emergency-disable-all`, `PUT /api/v1/admin/feature-flags/:key` |
| `messages:write` | operational | enforced | — | Retry and recover failed message deliveries. | — | `DELETE /api/v1/admin/messages/:id`, `POST /api/v1/admin/messages/:id/retry`, `POST /api/v1/admin/messages/retry-dead-letters` |
| `risk-metadata:write` | operational | enforced | — | Review and publish protocol risk metadata. | `PUT /api/v1/admin/risk-metadata/:protocolName` upserts an entry; each change writes a history row and an admin audit log row. | `PUT /api/v1/admin/risk-metadata/:protocolName` |
<!-- END GENERATED: admin-scope-catalog -->

### Withdrawal guardrails

- `withdraw:write` requires `allowWithdrawals: true` at key creation.
- Platform kill-switch: `USER_API_KEY_WITHDRAWALS_ENABLED=false` blocks all API-key withdrawals.
- API-key withdrawals still honor approval workflows, compliance freeze, and sub-account permissions.

## Management endpoints (session auth only)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/keys` | Create key (returns secret once) |
| `GET` | `/api/v1/keys` | List keys (metadata only) |
| `DELETE` | `/api/v1/keys/:id` | Revoke key |
| `POST` | `/api/v1/keys/:id/rotate` | Rotate secret |
| `GET` | `/api/v1/keys/:id/usage` | Usage metadata |

An API key **cannot** create, rotate, or revoke other keys.

## Scope catalogue endpoint (admin auth)

| Method | Path | Description | Scope |
|--------|------|-------------|-------|
| `GET` | `/api/v1/admin/keys/scopes` | The machine-readable scope catalogue, with the endpoints each scope covers | `keys:read` |

The response carries both scope families:

```jsonc
{
  "success": true,
  "data": {
    "user": {
      "defaultReadScopes": ["portfolio:read", "transactions:read", "vault:read"],
      "scopes": [
        {
          "scope": "withdraw:write",
          "description": "Create withdrawals.",
          "risk": "money",
          "grants": "Submits withdrawals to the durable outbox for on-chain settlement.",
          "enforcement": "enforced",
          "requires": "Requires allowWithdrawals on the key AND the platform kill-switch USER_API_KEY_WITHDRAWALS_ENABLED to be on.",
          "endpoints": ["POST /api/v1/withdraw"]
        }
      ]
    },
    "admin": {
      "scopes": [/* the same shape, for admin key scopes */]
    }
  }
}
```

The `endpoints` list is derived from the live route table, so a scope cannot
claim to unlock an endpoint that stopped requiring it.

## Errors

| Status | Error | Meaning |
|--------|-------|---------|
| 401 | `key_expired` | Key past `expiresAt` |
| 401 | `Invalid or revoked API key` | Bad token or revoked |
| 403 | `insufficient_scope` | Missing required scope |
| 403 | Session authentication required | API key used on session-only endpoint |
| 409 | Maximum active API keys reached | Per-user cap exceeded |

## Notifications

Every create/revoke/rotate emits `security.api_key_changed` on the real-time alerts stream.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `USER_API_KEY_MAX_ACTIVE` | 10 | Max active keys per user |
| `USER_API_KEY_WITHDRAWALS_ENABLED` | true | Platform withdrawal kill-switch |
