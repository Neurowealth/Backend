# API Reference

Comprehensive reference for all backend endpoints defined in src/routes.

## Base Information

- Base URL (local): http://localhost:3001
- Content type: application/json unless otherwise specified
- Auth header format: Authorization: Bearer <token>

## API Versioning

- All endpoints are served under an explicit version prefix: `/api/v1/<resource>` (for example `/api/v1/auth/challenge`).
- The legacy unversioned paths shown below (`/api/<resource>`) remain available as **deprecated aliases**. They still function but return `Deprecation: true` and `Sunset` headers and a `Link` header pointing at the `/api/v1` successor.
- Every response includes an `X-API-Version: 1` header.
- Breaking changes introduce a new major version (`/api/v2`); deprecated versions are supported for a minimum of 6 months before the announced `Sunset` date. The full policy lives in [`docs/api-versioning.md`](api-versioning.md).

## List Queries

Collection endpoints use bounded page-based pagination. `page` is 1-based and
defaults to `1`; `limit` defaults to `20` and is capped at `50`. The equivalent
SQL offset is `(page - 1) * limit`. List responses include `page`, `limit`,
`total`, `totalPages`, `hasNext`, and `hasPrevious`; an empty result has
`totalPages: 0` and both navigation flags set to `false`.

Where supported, `sortBy` is restricted to the fields documented for that
resource and `sortOrder` is `asc` or `desc` (default `desc`). The server applies
a stable ID tie-breaker. Filters are resource-specific and are applied before
both counting and fetching. Invalid page, limit, sort, or filter values return
`400` rather than being silently ignored.

This contract is used by transactions, portfolio positions, recurring deposit
plans, alert rules, webhooks, API keys, sessions, approvals, and agent decisions.

Supported list controls:

- Transactions: filter by `type`, `status`, `protocolName`, and inclusive `from`/`to` creation dates; sort by `createdAt`, `updatedAt`, or `amount`.
- Portfolio positions: filter by `status`, `protocolName`, and `assetSymbol`; sort by `openedAt`, `updatedAt`, `currentValue`, or `yieldEarned`. Portfolio summary totals remain account-wide.
- Recurring deposits: filter by `status`, `cadence`, and `assetSymbol`; sort by `createdAt`, `nextRunAt`, or `amount`.
- Alert rules: filter by `isActive`, `metric`, and `protocolName`; sort by `createdAt`, `updatedAt`, or `threshold`.
- Webhooks: filter by `isActive` and `event`; sort by `createdAt` or `updatedAt`.
- API keys: filter by `revoked`; sort by `createdAt`, `lastUsedAt`, or `expiresAt`.
- Sessions: sort by `lastSeenAt`, `createdAt`, or `expiresAt`.
- Approvals: filter by `status`; sort by `requestedAt` or `executedAt`.
- Agent decisions: filter by `outcome`, `fromProtocol`, and inclusive `from`/`to` creation dates; sort by `createdAt`, `outcome`, or `fromProtocol`.

## Authentication and Authorization

- Public endpoints: GET /health, POST /api/auth/challenge, POST /api/auth/verify, GET /api/whatsapp/webhook, POST /api/whatsapp/webhook, GET /api/vault/state, GET /api/protocols/rates, GET /api/protocols/agent/status, GET /api/agent/status
- Session auth endpoints: endpoints guarded by requireAuth require a valid live session token and reject missing, expired, or inactive sessions with 401 Unauthorized.
- User-scope endpoints: endpoints guarded by enforceUserAccess require the requested userId to match the authenticated userId.
- JWT middleware endpoint: POST /api/auth/logout uses AuthMiddleware.validateJwt and may return 401 with specific JWT/session errors.
- Twilio webhook auth: POST /api/whatsapp/webhook requires x-twilio-signature and TWILIO_AUTH_TOKEN; in production, invalid signatures are rejected with 403 Forbidden.

## Error Responses

Every 4xx/5xx response uses one JSON envelope, enforced centrally by
`errorResponseMiddleware` (`src/middleware/errorResponse.ts`) and the generic
`errorHandler`:

```json
{
  "status": 400,
  "code": "VALIDATION_ERROR",
  "message": "Validation failed",
  "error": "Validation failed",
  "details": [{ "field": "amount", "path": "amount", "message": "Number must be greater than 0" }],
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-09-27T12:00:00.000Z"
}
```

| Field | Notes |
|---|---|
| `status` | HTTP status code, repeated in the body |
| `code` | Machine-readable code. Defaults by status (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `TIMEOUT`, …); routes may return a more specific domain code |
| `message` | Human-readable message. **Always `Internal server error` for 500s** outside development; no stack traces or internal error text are ever returned |
| `error` | Deprecated alias of `message` for clients written against the old `{ "error": "..." }` shape |
| `details` | Optional. For validation failures from the `validate()` middleware it is an array of `{ field, message }` |
| `requestId` | Same value as the `X-Request-ID` response header — quote it when reporting issues |
| `timestamp` | ISO-8601 time the error was produced |

Additional route-specific fields (for example `success: false` or `retryAfter`)
are preserved alongside the envelope. Unknown routes return `404 NOT_FOUND`;
malformed JSON bodies return `400 BAD_REQUEST`. Health probes (`/health/*`) and
`/metrics` keep their own status payloads.

---

## Rate Limiting

All rate-limited routes return the following headers on every response:

| Header | Description |
|---|---|
| `RateLimit-Limit` | Maximum requests allowed in the current window |
| `RateLimit-Remaining` | Requests remaining in the current window |
| `RateLimit-Reset` | Seconds until the window resets |
| `RateLimit-Policy` | Policy string per IETF draft: `<limit>;w=<window-seconds>` (e.g. `100;w=900`) |

On `429 Too Many Requests` responses, an additional header is included:

| Header | Description |
|---|---|
| `Retry-After` | Seconds the client should wait before retrying |

Default limits by route group:

| Limiter | Max requests | Window | Policy header |
|---|---|---|---|
| Global (all routes) | 100 | 15 min | `100;w=900` |
| Auth (`/api/auth/*`) | 20 | 15 min | `20;w=900` |
| Admin (`/api/admin/*`) | 10 | 15 min | `10;w=900` |
| Webhook | 30 | 1 min | `30;w=60` |
| Internal / agent | 500 | 1 min | `500;w=60` |

Limits are configurable via environment variables (e.g. `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). Trusted IPs (`TRUSTED_IPS`) and requests bearing a valid `X-Internal-Token` (`INTERNAL_SERVICE_TOKEN`) bypass rate limiting entirely.

---

## Health

### GET /health

- Auth: none
- Description: Service health check.
- Request params: none
- Request body: none

Response 200:
{
"status": "ok",
"timestamp": "2026-04-26T14:45:00.000Z",
"version": "1.0.0",
"environment": "development"
}

---

## Agent

### GET /api/agent/status

- Auth: none
- Description: Returns runtime health and scheduling status for the agent loop.
- Request params: none
- Request body: none

Response 200:
{
"success": true,
"data": {
"isRunning": true,
"lastRebalanceAt": "2026-04-26T13:00:00.000Z",
"currentProtocol": "Blend",
"currentApy": "1.25",
"nextScheduledCheck": "2026-04-26T15:00:00.000Z",
"lastError": null,
"healthStatus": "healthy",
"timestamp": "2026-04-26T14:45:00.000Z"
}
}

Response 500:
{
"success": false,
"error": "Unknown error"
}

---

## Auth

### POST /api/auth/challenge

- Auth: none
- Description: Creates a one-time nonce for Stellar signature verification.
- Request params: none
- Request body schema:
  {
  "stellarPubKey": "string"
  }

Example request:
{
"stellarPubKey": "GABCD1234EXAMPLEPUBLICKEY"
}

Response 200:
{
"nonce": "nw-auth-<random-hex>",
"expiresAt": "2026-04-26T14:50:00.000Z"
}

Response 400:
{
"error": "stellarPubKey is required"
}

Response 400 (invalid key):
{
"error": "Invalid Stellar public key"
}

### POST /api/auth/verify

- Auth: none
- Description: Verifies signature over nonce, upserts user, creates session, returns token.
- Request params: none
- Request body schema:
  {
  "stellarPubKey": "string",
  "signature": "string"
  }

Example request:
{
"stellarPubKey": "GABCD1234EXAMPLEPUBLICKEY",
"signature": "base64-signature"
}

Response 200:
{
"token": "jwt-token",
"userId": "550e8400-e29b-41d4-a716-446655440004",
"expiresAt": "2026-04-27T14:45:00.000Z"
}

Response 400:
{
"error": "stellarPubKey and signature are required"
}

Response 401 examples:
{
"error": "No active challenge for this public key"
}
{
"error": "Challenge nonce has expired"
}
{
"error": "Invalid signature"
}

Response 500:
{
"error": "Internal server error"
}

### POST /api/auth/logout

- Auth: required (Authorization Bearer token validated via AuthMiddleware.validateJwt)
- Description: Revokes current session token.
- Request params: none
- Request body: none

Example request headers:
Authorization: Bearer <token>

Response 200:
{
"message": "Logged out successfully"
}

Response 401 examples (from middleware):
{
"error": "No token provided"
}
{
"error": "Invalid Bearer token"
}
{
"error": "Invalid token"
}
{
"error": "Session not found"
}
{
"error": "Session expired"
}

Response 500:
{
"error": "Internal server error"
}

---

## WhatsApp

### GET /api/whatsapp/webhook

- Auth: none
- Description: Twilio webhook liveness check.
- Request params: none
- Request body: none

Response 200 (text/plain):
WhatsApp webhook is alive

### POST /api/whatsapp/webhook

- Auth: Twilio signature validation
- Description: Receives incoming WhatsApp messages and returns TwiML response XML.
- Required header: x-twilio-signature
- Required environment: TWILIO_AUTH_TOKEN
- Request body (Twilio form payload, common fields):
  {
  "From": "whatsapp:+15550001234",
  "Body": "balance"
  }

Response 200 (text/xml):
<Response>
<Message>Your formatted assistant reply</Message>
</Response>

Response 403:
Forbidden

Notes:

- In production, invalid signatures are rejected.
- In non-production, invalid signatures may be tolerated for local testing if signature and auth token are present.

---

## Portfolio

### GET /api/v1/liquidity-floor

- Auth: required; returns only the authenticated caller's status.
- Returns the configured USD floor, active USDC balance, amount exitable within
  the 0.5% slippage target, yield-eligible amount, shortfall, estimated
  restoration time, and liquidity-data availability.
- Only fresh (24-hour) snapshots with explicit zero withdrawal delay and queue
  depth count as instantly liquid. Locked positions, pending transactions,
  unsupported assets, and missing or stale data do not count.
- `dataAvailable: false` means the agent blocks rebalancing until liquidity data
  is available. A floor above total balance is reported as a shortfall.

### PATCH /api/v1/liquidity-floor

- Auth: required; updates only the authenticated caller's floor.
- Request body: `{ "floorUsd": 500 }` sets a $500 minimum; `null` clears it;
  zero disables reserve sizing.
- The floor takes precedence over goals and strategy allocation. Restoration
  uses shortest known exits first and retains existing cost/payback gates; it is
  a target, not an instantaneous guarantee.

The Stellar DEX collector derives conservative depth from Horizon reserves.
Blend and Luma are counted only when their API responses explicitly include
valid depth, queue, and withdrawal-delay metadata.

### GET /api/portfolio/:userId

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params: none
- Request body: none

Response 200:
{
"userId": "550e8400-e29b-41d4-a716-446655440001",
"totalBalance": 8200,
"totalEarnings": 300,
"activePositions": 1,
"positions": [
{
"id": "pos-1",
"protocolName": "Blend",
"assetSymbol": "USDC",
"currentValue": 5200,
"yieldEarned": 200,
"status": "ACTIVE"
}
],
"whatsappReply": "..."
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

### GET /api/portfolio/:userId/history

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params:
  - period: enum(7d, 30d, 90d), default 30d
- Request body: none

Example request:
GET /api/portfolio/550e8400-e29b-41d4-a716-446655440001/history?period=30d

Response 200:
{
"userId": "550e8400-e29b-41d4-a716-446655440001",
"period": "30d",
"points": [
{
"date": "2026-04-25",
"yieldAmount": 5
}
],
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"period": ["Invalid option"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

### GET /api/portfolio/:userId/earnings

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params: none
- Request body: none

Response 200:
{
"userId": "550e8400-e29b-41d4-a716-446655440001",
"totalEarnings": 300,
"periodEarnings": 18,
"averageApy": 4.025,
"whatsappReply": "..."
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

### GET /api/portfolio/:userId/tax-report

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params:
  - year: integer (2000–2100), required — calendar year, UTC boundaries
  - format: enum(json, csv), default json
- Request body: none

Realized gain/loss report computed with FIFO cost-basis lot accounting over
confirmed on-chain withdrawals. Money fields are decimal strings; null means
"unpriced" (excluded from totals), never zero. See docs/TAX_REPORT.md for
methodology and known limitations.

Example request:
GET /api/portfolio/550e8400-e29b-41d4-a716-446655440001/tax-report?year=2026

Response 200 (json):
{
"userId": "550e8400-e29b-41d4-a716-446655440001",
"year": 2026,
"method": "FIFO",
"disposals": [
{
"disposedAt": "2026-06-15T00:00:00.000Z",
"assetSymbol": "USDC",
"amount": "40",
"withdrawalTxHash": "c1d2...",
"acquiredAt": "2026-01-15T00:00:00.000Z",
"acquisitionTxHash": "a1b2...",
"acquisitionPrice": "1",
"disposalPrice": "1",
"costBasis": "40",
"proceeds": "40",
"realizedGain": "0",
"priced": true
}
],
"totals": { "proceeds": "40", "costBasis": "40", "realizedGain": "0", "pricedDisposalCount": 1 },
"caveats": { "unpricedDisposalCount": 0, "unpricedAssets": [], "stablecoinAssumption": "...", "rebalancesNotIncluded": "..." }
}

Response 200 (format=csv): text/csv attachment (tax-report-2026.csv), header
row plus one row per disposal, formula-injection-safe cells.

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

---

## Transactions

### GET /api/transactions/detail/:txHash

- Auth: required (requireAuth)
- Path params:
  - txHash: string
- Query params: none
- Request body: none

Response 200:
{
"transaction": {
"id": "tx-id-1",
"txHash": "txhash-abc001",
"type": "DEPOSIT",
"status": "CONFIRMED",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend",
"createdAt": "2026-04-26T14:00:00.000Z"
},
"whatsappReply": "..."
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "Transaction not found"
}

### GET /api/transactions/:userId

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params:
  - page: int >= 1, default 1
  - limit: int between 1 and 50, default 20
  - type: optional transaction type
  - status: optional transaction status
  - protocolName: optional exact protocol match
  - from, to: optional inclusive ISO-8601 bounds on createdAt
  - sortBy: createdAt, updatedAt, or amount (default createdAt)
  - sortOrder: asc or desc (default desc)
- Request body: none

Example request:
GET /api/transactions/550e8400-e29b-41d4-a716-446655440002?page=2&limit=10&status=CONFIRMED&sortBy=amount&sortOrder=desc

Response 200:
{
"page": 2,
"limit": 10,
"total": 20,
"totalPages": 2,
"hasNext": false,
"hasPrevious": true,
"transactions": [
{
"id": "tx-id-1",
"txHash": "txhash-abc001",
"type": "DEPOSIT",
"status": "CONFIRMED",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend",
"createdAt": "2026-04-26T14:00:00.000Z"
}
],
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"page": ["Invalid input"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

---

## Protocols

### GET /api/protocols/rates

- Auth: none
- Description: Returns the latest 10 protocol rates.
- Request params: none
- Request body: none

Response 200:
{
"rates": [
{
"protocolName": "Blend",
"assetSymbol": "USDC",
"supplyApy": 8.75,
"borrowApy": 4.1,
"tvl": 1200000,
"network": "TESTNET",
"fetchedAt": "2026-04-26T14:00:00.000Z"
}
],
"whatsappReply": "..."
}

### GET /api/protocols/agent/status

- Auth: none
- Description: Returns latest persisted agent status record.
- Request params: none
- Request body: none

Response 200:
{
"status": "SUCCESS",
"action": "ANALYZE",
"updatedAt": "2026-04-26T14:00:00.000Z",
"whatsappReply": "..."
}

Response 404:
{
"error": "Agent status not found"
}

---

## Deposit

### POST /api/deposit

- Auth: required (requireAuth)
- Description: Executes an on-chain deposit and persists transaction.
- Request params: none
- Request body schema:
  {
  "userId": "uuid",
  "amount": "number > 0",
  "assetSymbol": "string",
  "protocolName": "string (optional)",
  "memo": "string <= 280 chars (optional)"
  }

Example request:
{
"userId": "550e8400-e29b-41d4-a716-446655440003",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend",
"memo": "monthly deposit"
}

Response 201:
{
"txHash": "chain-hash-0000000001",
"status": "CONFIRMED",
"transaction": {
"id": "tx-new",
"txHash": "chain-hash-0000000001",
"status": "CONFIRMED",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend"
},
"estFee": 100,
"estConfirmationSeconds": 8,
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"amount": ["Too small: expected number to be >0"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

Response 409:
{
"error": "Duplicate transaction hash"
}

---

## Withdraw

### POST /api/withdraw

- Auth: required (requireAuth)
- Description: Executes an on-chain withdrawal and persists transaction.
- Request params: none
- Request body schema:
  {
  "userId": "uuid",
  "amount": "number > 0",
  "assetSymbol": "string",
  "protocolName": "string (optional)",
  "memo": "string <= 280 chars (optional)"
  }

Example request:
{
"userId": "550e8400-e29b-41d4-a716-446655440004",
"amount": 50,
"assetSymbol": "USDC",
"protocolName": "Blend",
"memo": "withdraw to wallet"
}

Response 201:
{
"txHash": "withdraw-hash-0001",
"status": "CONFIRMED",
"transaction": {
"id": "withdraw-tx-new",
"txHash": "withdraw-hash-0001",
"status": "CONFIRMED",
"amount": 50,
"assetSymbol": "USDC",
"protocolName": "Blend"
},
"estFee": 500,
"estConfirmationSeconds": 4,
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"amount": ["Too small: expected number to be >0"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

Response 409:
{
"error": "Duplicate transaction hash"
}

---

## Vault

### GET /api/vault/state

- Auth: none
- Description: Returns current on-chain APY and active protocol.
- Request params: none
- Request body: none

Response 200:
{
"apy": 8.75,
"activeProtocol": "Blend"
}

### GET /api/vault/balance

- Auth: required (requireAuth)
- Description: Returns authenticated user on-chain vault balance and shares.
- Request params: none
- Request body: none

Response 200:
{
"balance": 1500.25,
"shares": 1450.1
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

---

## Endpoint Coverage Checklist (src/routes)

- health.ts: GET /health
- agent.ts: GET /api/agent/status
- auth.ts: POST /api/auth/challenge, POST /api/auth/verify, POST /api/auth/logout
- whatsapp.ts: GET /api/whatsapp/webhook, POST /api/whatsapp/webhook
- portfolio.ts: GET /api/portfolio/:userId, GET /api/portfolio/:userId/history, GET /api/portfolio/:userId/earnings
- transactions.ts: GET /api/transactions/detail/:txHash, GET /api/transactions/:userId
- protocols.ts: GET /api/protocols/rates, GET /api/protocols/agent/status
- deposit.ts: POST /api/deposit
- withdraw.ts: POST /api/withdraw
- vault.ts: GET /api/vault/state, GET /api/vault/balance
- network.ts: GET /api/v1/network/conditions

---

## Network

### GET /api/v1/network/conditions

- Auth: none (public, rate-limited)
- Description: Current fee oracle snapshot and per-priority ETA bands.
- Request params: none

Response 200:
{
"recommendedBaseFee": 100,
"aggressiveBaseFee": 500,
"congestionLevel": "low",
"ledgerCapacityUsage": 0.3,
"sampledAt": "2026-08-30T00:00:00.000Z",
"ttlMs": 30000,
"stale": false,
"etaBands": {
  "LOW": { "minSeconds": 10, "maxSeconds": 30 },
  "NORMAL": { "minSeconds": 5, "maxSeconds": 15 },
  "CRITICAL": { "minSeconds": 2, "maxSeconds": 8 }
}
}
