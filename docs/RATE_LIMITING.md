# Rate Limiting

Every route in this API is rate limited. This document is the map from a
route to the budget that applies to it, and the rules that decide which
budget a given caller draws on.

It is not hand-maintained prose. The tables below are generated from
`src/middleware/rateLimitTiers.ts`, and
`tests/unit/middleware/rateLimitTierMatrix.test.ts` fails CI if the tables,
the code and the route table disagree. If you add a route, the matrix entry
is part of the change — not a follow-up.

---

## Distributed enforcement (#635)

Rate-limit counters live in **Redis** (`src/middleware/rateLimitStore.ts`), the
same Redis already used for cache invalidation and the event bridge. Every
replica behind the load balancer draws on one number per bucket, so the
documented tier budgets hold at the fleet level — `n` pods do **not** mean `n x`
the limit.

- `NODE_ENV=test` keeps express-rate-limit's in-process `MemoryStore`, so unit
  tests never need Redis.
- If `REDIS_URL` is unset the limiter falls back to the per-pod store and logs a
  warning. A multi-replica deployment without Redis will exceed the documented
  limits; that is a deployment bug, not a tuning option.
- `Retry-After` and the `RateLimit-*` headers are derived from the shared
  counter, so a client throttled on one pod is throttled on all of them.

---

## The two layers every request passes through

Before a request reaches a route, it passes through the **app-wide chain**
(`src/middleware/rateLimiterChain.ts`):

| Tier | What it does |
| --- | --- |
| `global` | A flat budget over every request the server serves, matched or not. |
| `tiered` | The identity split. Anonymous callers draw on a strict per-IP budget; callers that have *proved* an identity draw on a generous per-principal one. |

A route-specific tier (`sensitive`, `optimizer`, …) is applied **in addition
to** the app-wide chain, never instead of it. A withdrawal is charged to the
global budget, the tiered budget and the sensitive budget — the sensitive one
is the tightest and therefore the one that bites first, but the other two
still cap a client that spreads its traffic across many endpoints.

The tiered tier is the only place where "who are you?" changes the answer.
An API key's own `rateLimitPerMin` overrides both the anonymous and the
authenticated allowance for that key.

---

## Which auth type maps to which tier

| Caller | How it is identified | Budget charged against |
| --- | --- | --- |
| **Session** | `req.userId`, set by `requireAuth` after the JWT is verified | The user id — one bucket per user, shared across that user's devices |
| **API key** | `nwk_<keyId>_<secret>` — self-describing in the `Authorization` header | The key id — two keys behind one NAT get two buckets, and the key's own `rateLimitPerMin` wins |
| **Admin key** | `X-Admin-Token` / `Authorization: Bearer` | The admin credential |
| **Webhook provider** | HMAC signature over the raw body (Twilio, Telegram, fiat) | The client IP — the signature is the credential, not a bearer token |
| **Internal service** | `X-Internal-Token` | The client IP — the internal token is a single shared credential |
| **Anonymous** | Nothing proven | The client IP, at the strict anonymous allowance |

A request is only ever charged to an identity the auth middleware has
*verified*. A `Authorization` header alone never upgrades a caller from
anonymous: otherwise an attacker could mint unlimited buckets by sending
garbage bearer tokens.

---

## The tier catalogue

Every tier in the system, with its live window and burst. The numbers come
from `config.security`, so this table cannot drift from what the limiter
actually enforces.

<!-- BEGIN GENERATED: tier-catalog -->
| Tier | Window | Burst | Principal | Auth types | Purpose |
| --- | --- | --- | --- | --- | --- |
| `global` | 900000ms | 100 | principal | session, api_key, admin, webhook, internal | Baseline budget for every route. Catches runaway clients and gives the more specific tiers something to sit on top of. |
| `tiered` | 900000ms | 60 | principal | session, api_key, admin, internal | Identity tiering. Anonymous callers draw on a strict per-IP budget; callers that proved an identity draw on a generous per-principal one. An API key’s own allowance overrides this tier entirely. |
| `auth` | 900000ms | 20 | ip | anonymous, session | Credential endpoints. Deliberately IP-keyed: credential stuffing happens before any identity is proven, so a per-user key would be meaningless here. |
| `admin` | 900000ms | 10 | principal | admin, internal | The management API. Tightest of the general tiers — these routes move reserves, mint keys and settle referrals. |
| `erasure` | 900000ms | 5 | principal | admin, internal | Right-to-erasure. Irreversible, so it is held far below the general admin budget — a bug that loops here would delete data repeatedly. |
| `webhook` | 60000ms | 30 | ip | webhook | Inbound provider callbacks. Unauthenticated at the transport layer — the HMAC signature is the credential — so the budget resists spoofed and replayed floods. |
| `sensitive` | 900000ms | 10 | principal | session, api_key | Money movement and credential changes. Applied per-endpoint IN ADDITION to the route’s normal budget, so a burst of withdrawals is stopped without throttling the balance reads the user needs to decide. |
| `optimizer` | 60000ms | 5 | principal | session, api_key | The CPU-bound allocation suggester. Pairs with the in-flight semaphore in src/utils/concurrency.ts: that bounds how many run at once, this bounds how often they start. |
| `simulate` | 60000ms | 6 | principal | session, api_key | The CPU-bound historical replay. Tight enough that the replay cannot be used as a CPU-exhaustion vector; pairs with the short-TTL result cache so identical previews are served without recomputing. |
| `internal` | 60000ms | 500 | ip | internal | Service-to-service calls (the agent loop). Higher throughput than the user-facing tiers, and IP-keyed because the internal token is a single shared credential. |
<!-- END GENERATED: tier-catalog -->

### Moving a tier

Each tier is controlled by a pair of environment variables (see
`src/config/env.ts`). The `tiered` tier has two pairs: the anonymous
allowance and the authenticated one.

| Tier | Window | Burst |
| --- | --- | --- |
| `global` | `RATE_LIMIT_WINDOW_MS` | `RATE_LIMIT_MAX` |
| `tiered` (anonymous) | `ANONYMOUS_RATE_LIMIT_WINDOW_MS` | `ANONYMOUS_RATE_LIMIT_MAX` |
| `tiered` (authenticated) | `AUTHENTICATED_RATE_LIMIT_WINDOW_MS` | `AUTHENTICATED_RATE_LIMIT_MAX` |
| `auth` | `AUTH_RATE_LIMIT_WINDOW_MS` | `AUTH_RATE_LIMIT_MAX` |
| `admin` | `ADMIN_RATE_LIMIT_WINDOW_MS` | `ADMIN_RATE_LIMIT_MAX` |
| `erasure` | fixed (15 min) | fixed (5) |
| `webhook` | `WEBHOOK_RATE_LIMIT_WINDOW_MS` | `WEBHOOK_RATE_LIMIT_MAX` |
| `sensitive` | `SENSITIVE_RATE_LIMIT_WINDOW_MS` | `SENSITIVE_RATE_LIMIT_MAX` |
| `optimizer` | `OPTIMIZER_RATE_LIMIT_WINDOW_MS` | `OPTIMIZER_RATE_LIMIT_MAX` |
| `simulate` | `SIMULATE_RATE_LIMIT_WINDOW_MS` | `SIMULATE_RATE_LIMIT_MAX` |
| `internal` | `INTERNAL_RATE_LIMIT_WINDOW_MS` | `INTERNAL_RATE_LIMIT_MAX` |

---

## The route → tier matrix

Paths are the canonical `/api/v1/*` ones. Every route is also served at the
legacy `/api/*` alias with the same handlers, and therefore the same tier.

<!-- BEGIN GENERATED: matrix -->
| Route | Method | Tier | Window | Burst | Why |
| --- | --- | --- | --- | --- | --- |
| `/api/v1/auth` | ANY | `auth` | 900000ms | 20 | Login, refresh, logout — credential stuffing surface. |
| `/api/v1/auth/webauthn` | ANY | `auth` | 900000ms | 20 | WebAuthn ceremonies — same credential surface as password auth. |
| `/api/v1/webauthn` | ANY | `auth` | 900000ms | 20 | Top-level WebAuthn alias, same ceremony budget. |
| `/api/v1/whatsapp` | ANY | `webhook` | 60000ms | 30 | Inbound WhatsApp provider callbacks, HMAC-signed. |
| `/api/v1/telegram` | ANY | `webhook` | 60000ms | 30 | Inbound Telegram provider callbacks, HMAC-signed. |
| `/api/v1/admin` | ANY | `admin` | 900000ms | 10 | Management API — reserves, key minting, referral settlement. |
| `/api/v1/admin/support/tickets` | ANY | `admin` | 900000ms | 10 | Admin view of support tickets. |
| `/api/v1/admin/notifications/dlq` | ANY | `admin` | 900000ms | 10 | Dead-letter queue inspection and replay. |
| `/api/v1/admin/erasure/requests` | POST | `erasure` | 900000ms | 5 | Creating an erasure request is a destructive operation. |
| `/api/v1/admin/erasure/requests/:id/approve` | POST | `erasure` | 900000ms | 5 | Approving an erasure request authorises data deletion. |
| `/api/v1/admin/erasure/requests/:id/reject` | POST | `erasure` | 900000ms | 5 | Rejecting an erasure request is part of the erasure workflow. |
| `/api/v1/admin/erasure/requests/:id/execute` | POST | `erasure` | 900000ms | 5 | Executing an erasure request deletes data — the sharpest edge. |
| `/api/v1/admin/erasure/preview/:userId` | GET | `erasure` | 900000ms | 5 | Previewing an erasure walks the same deletion path as the execute. |
| `/api/v1/deposit` | POST | `sensitive` | 900000ms | 10 | Deposits move money — irreversible once submitted. |
| `/api/v1/withdraw` | POST | `sensitive` | 900000ms | 10 | Withdrawals move money — irreversible once submitted. |
| `/api/v1/loans` | POST | `sensitive` | 900000ms | 10 | Loan origination moves money. |
| `/api/v1/loans/:loanId/repay` | POST | `sensitive` | 900000ms | 10 | Loan repayment moves money. |
| `/api/v1/keys` | POST | `sensitive` | 900000ms | 10 | Minting an API key is a takeover vector — credential change. |
| `/api/v1/keys/:id/rotate` | POST | `sensitive` | 900000ms | 10 | Rotating a key is a credential change. |
| `/api/v1/support/tickets` | POST | `sensitive` | 900000ms | 10 | Opening a ticket is a state change on a customer-visible record. |
| `/api/v1/accounting` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Accounting export is a user-scoped read gated by transactions:read; the reconciliation gate runs before any bytes are sent. |
| `/api/v1/portfolio/:userId/suggest-allocation` | POST | `optimizer` | 60000ms | 5 | CPU-bound allocation solver — the classic exhaustion vector. |
| `/api/v1/strategies/simulate` | POST | `simulate` | 60000ms | 6 | CPU-bound historical replay. |
| `/api/v1/agent/decisions` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Agent decision history is a user-facing read (session auth), not a service-to-service call — only the agent status endpoints are. |
| `/api/v1/agent` | ANY | `internal` | 60000ms | 500 | Agent loop endpoints — service-to-service, guarded by the internal token. |
| `/api/v1` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Default for every remaining versioned API route: the global budget plus the identity tier (strict per-IP when anonymous, generous per-principal once authenticated). |
| `/api/webhooks` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Pre-version webhook management surface; same baseline as /api/v1. |
| `/api/analytics` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Pre-version analytics alias; same baseline as /api/v1. |
| `/api/stellar` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Pre-version Stellar alias; same baseline as /api/v1. |
| `/health` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Liveness and readiness probes. The GLOBAL limiter skips these so k8s probes never consume the budget; the tiered limiter still applies. |
| `/metrics` | ANY | `tiered` | 900000ms / 600 authenticated | 60 | Prometheus scrape endpoint, guarded by the internal auth guard. |
<!-- END GENERATED: matrix -->

---

## Fail-open vs fail-closed

**Runtime: fail-open.** The app-wide chain (`global` + `tiered`) is mounted
before routing, so a route that is missing from the matrix still gets a
budget. No route is ever unlimited, and the "fail-open" label does not mean
"let the request through unchecked" — it means "degrade to the generic
budget instead of to none".

**CI: fail-closed.** The matrix is the contract, and the contract is
enforced. `tests/unit/middleware/rateLimitTierMatrix.test.ts` fails the
build when:

- a mounted route resolves to **no** matrix entry (an undocumented budget);
- the matrix says a route is in one tier while the code mounts a limiter
  from **another** (the table is lying);
- a matrix entry **no longer matches** any real route (the table has
  rotted);
- a limiter exists that the tier catalogue does **not** describe;
- `docs/RATE_LIMITING.md` is **not** the table this module generates.

The rationale: the runtime behaviour is a safety net for the case where
someone forgot; CI is where forgetting is caught. A gap in the matrix is
exactly the kind of silent drift this catalogue exists to prevent, and a
safety net that nobody notices is not a safety net.

---

## Response headers

Every limited response carries the IETF draft headers:

| Header | When | Meaning |
| --- | --- | --- |
| `RateLimit-Limit` | every response | The quota that was applied to *this* request |
| `RateLimit-Remaining` | every response | Requests left in the current window |
| `RateLimit-Reset` | every response | Seconds until the window resets |
| `RateLimit-Policy` | every response | `<quota>;w=<window-seconds>` — the effective policy |
| `Retry-After` | 429 only | Seconds until the caller may retry |

`RateLimit-Policy` reports the limit **actually applied**, not the tier
default. An API key with `rateLimitPerMin: 5` is told it has 5, so a client
that reads the header to schedule its retries does not keep hammering a
5/min endpoint believing it has 100.

---

## Adding a route

1. Decide the tier. Most routes take the default (`tiered`). A route that
   moves money or changes a credential takes `sensitive`. A CPU-bound route
   takes `optimizer` or `simulate`.
2. Add the entry to `RATE_LIMIT_MATRIX` in `src/middleware/rateLimitTiers.ts`.
   Use an **exact** path for a single endpoint; set `prefix: true` only when
   the entry is meant to cover a whole router.
3. If the route needs its own limiter, build it with `buildRateLimiter({ …,
   tier: 'sensitive' })` and mount it on the route. The tier tag is what
   makes the matrix checkable.
4. Run `npm test -- rateLimitTierMatrix`. It will tell you if the matrix and
   the code disagree.
