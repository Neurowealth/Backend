# feat: Webhook Subscription System

## Summary

Adds a full server-push webhook system so integrators (mobile apps, dashboards) can receive real-time event notifications without polling.

---

## What Changed

### Database
| Model | Purpose |
|---|---|
| `WebhookSubscription` | Stores subscriber URL, event filters, HMAC secret, and active state per user |
| `WebhookDelivery` | Immutable delivery log — tracks attempts, HTTP status, and error per dispatch |

Migration: `prisma/migrations/20260627000000_add_webhook_tables/`

---

### API — `POST /api/webhooks` (new endpoint group)

All routes require `Authorization: Bearer <JWT>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/webhooks` | Create subscription — **returns secret once** |
| `GET` | `/api/webhooks` | List subscriptions (no secrets) |
| `GET` | `/api/webhooks/:id` | Get single subscription |
| `PATCH` | `/api/webhooks/:id` | Update URL / events / active state |
| `DELETE` | `/api/webhooks/:id` | Delete subscription + delivery history |

---

### Payload Signing

Every outbound webhook POST carries:

```
X-Neurowealth-Signature: sha256=<hmac-hex>
```

Computed as `HMAC-SHA256(secret, raw_body)`. Recipients verify by recomputing with their stored secret.

---

### Events Dispatched

| Event | Fired from |
|---|---|
| `transaction.confirmed` | `transaction-controller.ts` — on-chain tx confirmed |
| `deposit.received` | `stellar/events.ts` — deposit event processed |
| `withdraw.completed` | `stellar/events.ts` — withdraw event processed |
| `agent.rebalanced` | `stellar/events.ts` + `agent/loop.ts` — rebalance executed |

---

### Retry Logic

Failed deliveries are retried **up to 3 times** with exponential back-off:

```
attempt 1 → immediate
attempt 2 → wait 1 s
attempt 3 → wait 2 s
```

Each attempt is logged in `WebhookDelivery`. After all attempts fail the record is marked `FAILED` and logged as an error. Dispatch is always fire-and-forget — failures never block the request path.

---

## Files Changed

```
prisma/schema.prisma                              ← new models + relation
prisma/migrations/20260627000000_add_webhook_tables/migration.sql

src/utils/webhookSignature.ts                     ← generateSecret + signPayload
src/services/webhookDispatcher.ts                 ← dispatch + retry + delivery log
src/routes/webhooks.ts                            ← CRUD router
src/validators/webhook-validators.ts              ← Zod schemas

src/index.ts                                      ← mount /api/webhooks
src/stellar/events.ts                             ← fire deposit/withdraw/rebalance events
src/agent/loop.ts                                 ← fire agent.rebalanced on rebalance
src/controllers/transaction-controller.ts         ← fire transaction.confirmed

tests/unit/utils/webhookSignature.test.ts         ← 5 tests
tests/unit/services/webhookDispatcher.test.ts     ← 8 tests

docs/openapi.yaml                                 ← webhooks tag + schemas + paths
README.md                                         ← API table updated
```

---

## Tests

```
PASS  tests/unit/utils/webhookSignature.test.ts    (5 tests)
PASS  tests/unit/services/webhookDispatcher.test.ts (8 tests)
```

Covers: secret uniqueness, HMAC correctness, success on first attempt, exhausted retry → FAILED, partial retry → SUCCESS, signature header format, subscription event filtering.

---

## Acceptance Criteria

- [x] `POST /api/webhooks` creates subscription, returns signing secret once
- [x] Payload signed with HMAC-SHA256, verifiable by recipient via `X-Neurowealth-Signature`
- [x] Failed deliveries retried (≤3) and logged in `WebhookDelivery` table
- [x] Unit tests for signature generation and retry logic
- [x] OpenAPI spec updated

---

## Testing Locally

```bash
# 1. Apply migration
npx prisma migrate dev

# 2. Create a subscription
curl -X POST http://localhost:3000/api/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://webhook.site/your-id","events":["deposit.received","transaction.confirmed"]}'
# → response includes `secret` — save it

# 3. Verify a delivery signature on receipt
echo -n '<raw_body>' | openssl dgst -sha256 -hmac '<secret>'
# should match X-Neurowealth-Signature header (minus "sha256=" prefix)
```
