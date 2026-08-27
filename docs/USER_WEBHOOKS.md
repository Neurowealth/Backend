# User-Scoped Outbound Webhooks (#368)

User-scoped webhooks allow individual NeuroWealth account holders to register HTTPS endpoints to receive real-time HTTP POST notifications when events occur on their account (or permitted child sub-accounts).

## Overview & Architecture

Unlike operator-scoped webhooks (which fan out to system-wide operator endpoints with full domain payloads), **user-scoped webhooks deliver the exact redacted per-user projection** computed for the real-time stream.

Key capabilities:
- **Per-User Signing Secrets**: Each endpoint receives a unique HMAC secret (`whsec_...`) shown **only once** upon creation or secret rotation.
- **Event & Topic Scoping**: Endpoints can filter by specific domain events (`events: ["deposit.received", "agent.rebalanced"]`) or topic scopes (`topicScope: ["portfolio", "transactions"]`).
- **Server-side Filter Predicates**: Supports optional validated filter JSON predicates evaluated before delivery enqueueing (e.g. only `WITHDRAWAL` transactions over $100).
- **Idempotency & Replay**: Deliveries use `@@unique([endpointId, userEventSeq])` based on the user's durable stream sequence (`seq`). Endpoints can request replay via `POST /api/v1/webhooks/endpoints/:id/replay?afterSeq=`.
- **SSRF Protection**: Endpoint URLs must use `https://` and are validated against private, loopback, and link-local IP ranges.
- **Auto-Disabling**: After 5 consecutive delivery failures, an endpoint is marked `DISABLED_BAD_ENDPOINT` and a `webhook.endpoint_disabled` event is emitted.

---

## Signature Verification

Deliveries include an `X-NeuroWealth-Signature` header in the format:
```http
X-NeuroWealth-Signature: t=1700000000,v1=6a3f9e...
```

To verify the signature on your server:
1. Extract timestamp `t` and signature `v1`.
2. Compute HMAC-SHA256 over `${timestamp}.${rawBody}` using your endpoint secret.
3. Compare the computed hex digest against `v1`.

### Example Node.js Verification

```javascript
const crypto = require('crypto');

function verifyWebhook(rawBody, signatureHeader, secret) {
  const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const expectedSig = parts.v1;

  const signedPayload = `${timestamp}.${rawBody}`;
  const actualSig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(actualSig));
}
```

---

## Management Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/v1/webhooks/endpoints` | Register a new endpoint (returns secret once) |
| `GET` | `/api/v1/webhooks/endpoints` | List caller's webhook endpoints |
| `GET` | `/api/v1/webhooks/endpoints/:id` | Get endpoint details |
| `PATCH` | `/api/v1/webhooks/endpoints/:id` | Update URL, events, filterJson, or status |
| `DELETE` | `/api/v1/webhooks/endpoints/:id` | Delete endpoint |
| `POST` | `/api/v1/webhooks/endpoints/:id/rotate-secret` | Rotate HMAC secret (returns new secret once) |
| `POST` | `/api/v1/webhooks/endpoints/:id/test` | Dispatch `webhook.test` ping event |
| `POST` | `/api/v1/webhooks/endpoints/:id/replay?afterSeq=` | Re-enqueue events from stream |
| `GET` | `/api/v1/webhooks/endpoints/:id/deliveries` | View recent delivery history |
