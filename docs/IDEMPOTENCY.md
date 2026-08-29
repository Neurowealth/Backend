# Idempotency-Key Contract (#375)

Client-supplied idempotency keys protect mutating REST endpoints from duplicate side effects on retry.

## Header

```http
Idempotency-Key: <opaque, client-generated, ≤255 chars>
```

## Behavior

| Case | Response |
|------|----------|
| First request (miss) | Handler runs normally; response stored |
| Retry, same fingerprint | Original `statusCode` + body replayed; `Idempotency-Replayed: true` |
| Same key, different body | `422 idempotency_key_reuse` |
| Request still in flight | `409 idempotency_request_in_flight` |
| Missing on money routes | `400 idempotency_key_required` |

## Fingerprint

Hash of `(method, path, userId, canonicalized JSON body)`. Key ordering is normalized; arrays are order-sensitive.

## Storage

- **Primary:** Redis (`idem:<userId>:<key>`, TTL-bound)
- **Durability:** `IdempotencyRecord` DB table for money routes (Redis miss fallback)
- **Lock:** Redis `SET NX PX` (30s) prevents concurrent double-submit

## Route policy

| Route | Header | Fail mode | TTL |
|-------|--------|-----------|-----|
| `POST /deposit` | Required | Fail closed | 24h |
| `POST /withdraw` | Required | Fail closed | 24h |
| `POST /fiat/orders` | Required | Fail closed | 24h |
| `POST /deposit/recurring` | Required | Fail closed | 24h |

When Redis and DB are both unavailable on money routes → `503`. Non-money routes fail open (no dedupe).

## Relationship to outbox idempotency

The client `Idempotency-Key` sits **in front of** the outbox. A replayed request returns the original response (referencing the original outbox op). The outbox's `deriveIdempotencyKey` remains a second line of defense.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `IDEM_MAX_BODY_BYTES` | 65536 | Max stored response body size |
