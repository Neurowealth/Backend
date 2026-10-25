# Idempotency-Key Contract (#375, #483)

Client-supplied idempotency keys protect high-risk and mutating REST API endpoints from duplicate side effects caused by network timeouts, automatic client retries, UI double-submissions, or mobile reconnection.

## Header Specification

Clients initiate mutating actions with an opaque `Idempotency-Key` header:

```http
Idempotency-Key: <client-generated UUIDv4 or opaque token, <= 255 ASCII characters>
```

### Constraints & Validation
- **Length:** Must not exceed 255 characters. Exceeding this limit returns `400 Bad Request` with `{ "error": "idempotency_key_too_long" }`.
- **Character Set:** Printable ASCII strings without leading/trailing whitespace.
- **Scope:** Idempotency records are scoped to `(userId, idempotencyKey)`. Different authenticated users may independently use identical keys without collision.

---

## State Machine & Response Behavior

| Case | HTTP Status | Response Header | Body / Error Code | Description |
|------|-------------|-----------------|-------------------|-------------|
| **First Request (Cache Miss)** | `2xx` / `4xx` / `5xx` | None | Original handler response | Request is processed normally; result status and serialized body are persisted to Redis and `IdempotencyRecord` table. |
| **Duplicate Submission (Replay)** | Original status code (e.g. `200`, `201`) | `Idempotency-Replayed: true` | Original response body | The request matches the exact key and payload fingerprint. The cached response is returned immediately without executing the downstream business logic or on-chain transaction. |
| **Payload Mismatch (Key Reuse)** | `422 Unprocessable Entity` | None | `{ "error": "idempotency_key_reuse" }` | The same `Idempotency-Key` was re-submitted with a different payload body, method, or path. Reusing keys across different operations is forbidden. |
| **Concurrent Request In-Flight** | `409 Conflict` | None | `{ "error": "idempotency_request_in_flight" }` | An earlier request with the identical key is currently executing. Clients should back off with exponential jitter before retrying. |
| **Missing Header on Required Route** | `400 Bad Request` | None | `{ "error": "idempotency_key_required" }` | Financial money routes require `Idempotency-Key`. The request is rejected before any fund movement. |
| **Store Outage (Fail Closed)** | `503 Service Unavailable` | None | `{ "error": "Idempotency store unavailable" }` | Returned on critical financial routes when both Redis and Postgres database stores are inaccessible. |

---

## Fingerprint Algorithm

To detect key reuse with modified parameters, the middleware computes a SHA-256 fingerprint:

$$\text{fingerprint} = \text{SHA256}(\text{method} \parallel \text{path} \parallel \text{userId} \parallel \text{canonicalJSON}(\text{body}))$$

- **Canonical JSON:** Object keys are sorted lexicographically at all nested depths. Arrays preserve their operational order.
- **Empty / Null Bodies:** Normalized to an empty string.

---

## Protected Endpoints & Route Policy

| Route | Method | Idempotency Key | Fail Mode | Default TTL | Category |
|-------|--------|-----------------|-----------|-------------|----------|
| `/api/deposit` | `POST` | **Required** | Fail closed (`503`) | 24 hours | Financial (Deposit) |
| `/api/withdraw` | `POST` | **Required** | Fail closed (`503`) | 24 hours | Financial (Withdrawal) |
| `/api/fiat/orders` | `POST` | **Required** | Fail closed (`503`) | 24 hours | Financial (Fiat on/off-ramp) |
| `/api/deposit/recurring` | `POST` | **Required** | Fail closed (`503`) | 24 hours | Financial (Recurring plan) |
| `/api/approvals/:id/approve` | `POST` | Optional (Supported) | Fail open | 24 hours | Operational (Multi-sig/governance) |
| `/api/approvals/:id/reject` | `POST` | Optional (Supported) | Fail open | 24 hours | Operational (Multi-sig/governance) |
| `/api/approvals/:id/cancel` | `POST` | Optional (Supported) | Fail open | 24 hours | Operational (Multi-sig/governance) |
| `/api/portfolio/goals` | `POST` | Optional (Supported) | Fail open | 24 hours | Operational (Savings goal creation) |

---

## Two-Tier Storage Architecture

1. **Fast Tier (Redis):**
   - Key format: `idem:<userId>:<idempotencyKey>`
   - Distributed lock via `SET ... PX 30000 NX` guarantees atomic single-execution under concurrent race conditions.
   - Completed responses cached with TTL (default 86,400s / 24h).
2. **Durable Tier (PostgreSQL `IdempotencyRecord`):**
   - Backing table defined in `prisma/schema.prisma` with `@@unique([userId, idempotencyKey])`.
   - Survives Redis eviction, flush, or restart for all financial transactions.
   - Automatic expiration index on `expiresAt`.

---

## Relationship to Outbox & Ledger Idempotency

The HTTP `Idempotency-Key` serves as the **outer perimeter** defense at the client boundary:
1. **Perimeter (HTTP Idempotency):** Catches duplicate client requests before running business logic, controllers, or database locks. Replays return the original response with `Idempotency-Replayed: true`.
2. **Outbox Core (`OutboxOp`):** Generates deterministic `idempotencyKey = "<kind>:<userId>:<businessRecordId>"` ensuring asynchronous queue workers never submit duplicate transactions to Stellar/Soroban.
3. **Ledger Boundary (`ProcessedEvent`):** Stellar transaction hashes and event sequences are recorded in the database to prevent duplicate ingestion of on-chain events.

---

## Consumer Contract (what callers can rely on)

The sections above describe the mechanism. This section is the externally
guaranteed behaviour; it does not change when the implementation does.

### Retention and TTL

A completed record is retained for the TTL of its route (24 h on every current
route). A record expires `ttlSeconds` after it was last written: both tiers
(Redis and Postgres `IdempotencyRecord`) carry the same expiry.

If a retry arrives **after** the record has expired, the key is treated as new:
the handler runs again and side effects are executed again. Clients that retry
across long gaps are themselves responsible for using a fresh key rather than
relying on replay — the server will not block an expired-key re-execution.

The TTL is a floor, not a ceiling: a record may still be in Redis after its
nominal TTL (eviction is lazy) but the Postgres row's `expiresAt` check is
authoritative. A record found with `expiresAt <= now` is treated as absent.

### Which status codes replay vs re-execute

**Every status code is cached and replayed**, including `4xx` validation errors
and `5xx` handler errors — a client that retries after a `400` will see the
same `400` on an identical replay, not a second `400` produced by re-running
validation. The only cases that re-execute are:

- The key is unknown (first request).
- The key has expired (see above).
- The key is present but the fingerprint differs → `422` with
  `idempotency_key_reuse`, no re-execution.
- The key is present in `in_progress` state → `409` with
  `idempotency_request_in_flight`, no re-execution.

A request that completes without `res.json(...)` being called (plain
`res.send`, `res.end`, or an error thrown past the response boundary) is **not
cached**. A retry of such a request re-executes.

### Same key, different body

Returns `422 Unprocessable Entity` with `{ "error": "idempotency_key_reuse" }`.
Not `409`: `409` is reserved for the concurrency case below, so clients can
distinguish "I sent two different payloads with the same key" (a bug on their
end) from "my earlier request is still running" (worth backing off and
retrying).

The fingerprint covers `method`, `path`, `userId`, and the canonical JSON of
the request body. Two requests that differ **only** in header casing, query
string ordering of unmentioned params, or whitespace inside their JSON body
have the same fingerprint.

### Concurrency: in-flight duplicate

The policy is **reject with `409`, do not coalesce**. A second request with
the same key, received while the first is still executing, returns
`409 Conflict` with `{ "error": "idempotency_request_in_flight" }`. The second
request does **not** wait for the first to finish, and does **not** receive
the first request's response body when it does.

Clients should back off (exponential jitter, start at ~2 s) and retry with the
same key once the first request has completed. On the follow-up retry the
server will either replay the cached response or — if the first request
genuinely failed and left no record — re-execute. The in-flight lock expires
after 30 s so a crashed first request cannot wedge the key.

### Fail-closed stores

On routes marked **Fail closed** (every financial route in the table above),
if both Redis and Postgres are unreachable the request is rejected with
`503 Service Unavailable` and `{ "error": "Idempotency store unavailable" }`.
No handler runs; no funds move. Operational routes fail open — the handler
runs without the dedupe guarantee.

### Behavioural guarantees (tested)

Each row below is pinned by a test in
`tests/unit/middleware/idempotencyContract.test.ts`:

| Behaviour                                                         | Expected                                   |
|-------------------------------------------------------------------|--------------------------------------------|
| First request, no key, non-required route                         | handler runs, nothing cached                |
| First request, no key, required route                             | `400 idempotency_key_required`              |
| Key > 255 chars                                                   | `400 idempotency_key_too_long`              |
| Replay with identical fingerprint, cached `2xx`                   | cached body, `Idempotency-Replayed: true`   |
| Replay with identical fingerprint, cached `4xx` or `5xx`          | cached body, `Idempotency-Replayed: true`   |
| Same key, different body                                          | `422 idempotency_key_reuse`                 |
| Second request while first is in-flight                           | `409 idempotency_request_in_flight`         |
| Replay after record TTL has elapsed                               | handler re-runs                             |
| Required route with both stores down                              | `503`                                       |

## Client Integration Guide & Best Practices

```typescript
import { v4 as uuidv4 } from 'uuid';

async function executeDeposit(amount: number, asset: string) {
  const idempotencyKey = uuidv4();

  const response = await fetch('/api/deposit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ amount, assetSymbol: asset }),
  });

  if (response.status === 409) {
    // Request is in-flight: wait and retry with the SAME key
    await sleep(2000);
    return retryWithSameKey(idempotencyKey);
  }

  const isReplay = response.headers.get('Idempotency-Replayed') === 'true';
  const data = await response.json();
  return { data, isReplay };
}
```
