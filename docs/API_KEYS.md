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

| Scope | Description |
|-------|-------------|
| `portfolio:read` | Read portfolio data |
| `transactions:read` | Read transaction history |
| `deposit:write` | Create deposits |
| `withdraw:write` | Create withdrawals (opt-in per key) |
| `alerts:manage` | Manage alert rules |
| `fiat:write` | Create fiat orders |
| `recurring_deposits:write` | Manage recurring deposit plans |
| `goals:write` | Manage savings goals |
| `strategies:write` | Manage strategies |
| `webhooks:manage` | Manage webhook subscriptions |
| `vault:read` | Read vault data |
| `vault:write` | Write vault operations |

New keys are **read-only by default**. Write scopes must be explicitly requested.

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
