# Session & Device Management (#376)

Users can view, name, and revoke their active sessions across devices.

## Session model

Each session carries:

| Field | Description |
|-------|-------------|
| `label` | User-set device name |
| `deviceType` | Best-effort UA hint: `web`, `ios`, `android`, `cli`, `unknown` |
| `approxLocation` | Coarse city/country from offline GeoIP (null for private IPs) |
| `lastSeenAt` / `lastSeenIp` | Updated async, throttled to ≤1/min |
| `revokedAt` / `revokedReason` | Soft revocation (`user`, `logout_others`, `admin`, etc.) |

## Endpoints (session auth only)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/sessions` | List caller's sessions |
| `PATCH` | `/api/v1/sessions/:id` | Set label |
| `DELETE` | `/api/v1/sessions/:id` | Revoke one session |
| `POST` | `/api/v1/sessions/revoke-others` | Revoke all except current (step-up) |

### IP masking

IPs are masked to `/24` by default (`1.2.3.xxx`). Pass `?fullIp=true` for the full address (logged server-side).

## Auth behavior

- Revoked sessions return `401 session_revoked` (distinct from `session_expired`)
- Refresh tokens on revoked sessions are rejected with `401 session_revoked`
- API keys cannot access session endpoints

## New session notifications

On `verify`, a `security.new_session` event is emitted with device metadata and a signed deep link. The link requires normal auth to act — it does not auto-revoke.

## Admin endpoints

| Method | Path | Scope |
|--------|------|-------|
| `GET` | `/api/admin/users/:id/sessions` | `read` |
| `POST` | `/api/admin/users/:id/sessions/revoke-all` | `write` |

All admin session actions are audit-logged.

## Cleanup

Revoked sessions are retained for `REVOKED_SESSION_RETAIN_DAYS` (default 7) then hard-deleted by `sessionCleanup`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REVOKED_SESSION_RETAIN_DAYS` | 7 | Days to keep revoked sessions visible |
