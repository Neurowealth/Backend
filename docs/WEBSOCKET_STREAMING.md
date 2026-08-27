# Real-Time WebSocket Streaming (#316)

Authenticated, per-user, sequence-numbered event streaming with resumable
replay. Replaces polling `/api/portfolio`, `/api/transactions`, and
`/api/analytics` for live views.

Endpoint: **`GET /api/v1/ws`** (configurable via `WS_PATH`).
Machine-readable subprotocol: `docs/openapi.yaml`, operation `openRealtimeStream`.

---

## 1. What this is, and what it is not

The platform already produces an ordered stream of user-facing events —
deposits, withdrawals, rebalances, alert triggers, strategy changes — and
already fans them out to operator-configured endpoints through
`src/services/webhookDispatcher.ts`. This feature exposes the same stream to the
**end user**, over an authenticated socket, with no message loss across a
reconnect.

**Receive-only in v1.** The client→server side is a control channel:
`subscribe`, `resume`, `unsubscribe`, `ping`. State-changing operations stay on
the REST surface, which has the validation, rate limiting, idempotency, and
audit trail a socket does not. A second, weaker path to move money is not a
feature.

---

## 2. Connecting

### Authentication

The handshake runs the same checks as `src/middleware/authenticate.ts`:
signature → live session row → expiry → active user. It runs **before** the
protocol switch, so an unauthenticated peer receives an HTTP `401` and never
becomes a WebSocket. There is no anonymous fallback.

Two ways to present the token:

```bash
# Server-side clients
wscat -c ws://localhost:3001/api/v1/ws -H "Authorization: Bearer $JWT"
```

```javascript
// Browsers — a WebSocket cannot set headers, so the token rides the subprotocol
const ws = new WebSocket('wss://api.example.com/api/v1/ws', ['bearer', jwt])
```

A `?token=` query parameter is **not** accepted. URLs land in access logs, proxy
logs, and referrer headers, and this token is a live session.

### Sub-account (delegated) connections

A parent may bind the connection to a child's stream:

```
GET /api/v1/ws?actor=<childUserId>
```

The server looks up the `SubAccount` grant, requires `status = ACTIVE`, and
derives the readable topics from its permissions. The client's opinion about its
own scope is never consulted — the same enforcement the REST `actingAsUserId`
routes apply.

| Permission        | Topics unlocked                              |
|-------------------|----------------------------------------------|
| `VIEW`            | `portfolio`, `transactions`, `agent`, `alerts` |
| `MANAGE_STRATEGY` | `strategies`                                 |

`DEPOSIT` / `WITHDRAW` add no topics of their own — the confirmations they
produce are already covered by `transactions` under `VIEW`.

Authorisation is also re-resolved **at publish time**, from live grants, for
every single event (see `resolveAuthorizedViewers` in
`src/events/publisher.ts`). A grant revoked mid-connection stops delivery on the
very next event, with no cache to invalidate and no reconnect required.

### Revocation

A session revoked while a socket is open closes it with code `4408`. Logout
closes the user's sockets on the handling pod immediately; a periodic
re-verification (`WS_SESSION_RECHECK_MS`, default 60s) is the backstop that
covers every other way a session can die — expiry, account deactivation, admin
action — and sockets held on other pods.

---

## 3. Topics

`portfolio` · `transactions` · `agent` · `alerts` · `strategies`

| Topic          | Carries                                                            | Source |
|----------------|--------------------------------------------------------------------|--------|
| `transactions` | deposit/withdraw/settlement confirmations, fiat orders, recurring deposits, terminal outbox failures | `src/stellar/events.ts`, `src/fiat/service.ts`, `src/controllers/transaction-controller.ts` |
| `portfolio`    | value/position changes                                             | `src/agent/loop.ts` |
| `agent`        | rebalance decisions                                                | `src/agent/loop.ts` |
| `alerts`       | `alert_rule.triggered`                                             | `src/jobs/alertRules.ts` |
| `strategies`   | publish / unpublish / material config change                       | `src/strategy/service.ts` |

### Ordering contract

* **Within a topic**: events are delivered in ascending `seq`.
* **Across topics**: no ordering is guaranteed. All topics share one per-user
  sequence, so if you need a cross-topic order, sort by `seq` — never by
  arrival.
* On-chain events inherit `ProcessedEvent`'s ledger ordering upstream of this
  layer.

---

## 4. Message flow

```
client                                   server
  │  ── upgrade (Bearer JWT) ──────────────▶│
  │◀── hello { topics, currentSeq } ────────│
  │  ── subscribe { topics } ──────────────▶│
  │◀── subscribed { topics, currentSeq } ───│
  │◀── event { seq: 41, … } ────────────────│
  │◀── event { seq: 42, … } ────────────────│
  ✗   connection drops
  │  ── upgrade ───────────────────────────▶│
  │◀── hello ───────────────────────────────│
  │  ── resume { topics, afterSeq: 42 } ───▶│
  │◀── replay { status: start, count: 3 } ──│
  │◀── event { seq: 43 } … { seq: 45 } ─────│
  │◀── replay { status: end } ──────────────│
  │◀── subscribed  (now live) ──────────────│
```

`subscribe` starts at **now** — it does not replay history. History is what
`resume` is for.

### Client messages

```jsonc
{ "type": "subscribe",   "topics": ["portfolio", "transactions"], "coalesce": false }
{ "type": "resume",      "topics": ["portfolio"], "afterSeq": 42 }
{ "type": "unsubscribe", "topics": ["agent"] }
{ "type": "ping" }
```

Schemas are strict: an unknown key or an unknown message type produces a
`bad_request` error frame rather than being silently ignored, so a client using
something this server does not implement finds out immediately.

### Server frames

| Frame        | When |
|--------------|------|
| `hello`      | First frame after a successful handshake |
| `subscribed` | Acknowledges the active subscription set |
| `event`      | One domain event, with `seq`, `topic`, `event`, `payload`, `emittedAt` |
| `replay`     | `status: start` / `status: end` brackets around a resume replay |
| `gap`        | The stream could not be served continuously — see §6 |
| `error`      | `bad_request` · `forbidden` · `unauthorized` · `rate_limited` · `internal` |
| `draining`   | Graceful shutdown; reconnect and resume |
| `pong`       | Reply to an application-level `ping` |

---

## 5. Delivery guarantees

**At-least-once, with a duplication window at reconnect.** A `resume` replays
from the durable store while live events keep arriving; the live-switch prefers
replaying an event twice over dropping it, because a hole would leave a client
waiting forever for a `seq` that never comes.

**Dedupe on `seq`.** It is monotonic and gapless per user, allocated by an
atomic counter inside the same transaction that writes the event.

```javascript
let lastSeq = Number(localStorage.getItem('lastSeq') ?? 0)

ws.onmessage = (raw) => {
  const frame = JSON.parse(raw.data)
  if (frame.type !== 'event') return handleControlFrame(frame)
  if (frame.seq <= lastSeq) return          // duplicate from the replay window
  lastSeq = frame.seq
  localStorage.setItem('lastSeq', String(lastSeq))
  apply(frame)
}
```

---

## 6. Gaps, and how to close them

A `gap` frame means the stream could not be served continuously. It always
carries enough to recover.

```jsonc
{
  "type": "gap",
  "reason": "retention",          // retention | backpressure | unknown_stream
  "afterSeq": 12,                 // what you asked to resume after
  "currentSeq": 481,              // newest seq that exists right now
  "oldestAvailableSeq": 130,      // oldest still replayable (null if empty)
  "snapshotRequired": true
}
```

| `reason`         | Cause | Recovery |
|------------------|-------|----------|
| `retention`      | `afterSeq` is older than what is retained, or one replay hit its page limit with history still to come | If `snapshotRequired`, fetch a REST snapshot and `subscribe`; otherwise `resume` again from `currentSeq` in the frame |
| `backpressure`   | Your client fell behind and delivery stopped | `resume` from `afterSeq` — nothing was lost, the durable stream still holds it |
| `unknown_stream` | `afterSeq` is ahead of the server (restored from a stale cache, or the stream was reset) | Fetch a REST snapshot and `subscribe` |

```javascript
if (frame.type === 'gap') {
  if (frame.snapshotRequired) {
    await refetchFromRest()            // /api/v1/portfolio, /api/v1/transactions, …
    lastSeq = frame.currentSeq
    send({ type: 'subscribe', topics })
  } else {
    send({ type: 'resume', topics, afterSeq: frame.currentSeq })
  }
}
```

---

## 7. Backpressure and event storms

**A slow consumer never costs the server memory.** Past either bound —
`WS_MAX_BUFFERED_EVENTS` in-process frames or `WS_MAX_BUFFERED_BYTES` unflushed
socket bytes — the connection stops delivering, sends **one** `gap` frame with
reason `backpressure` carrying the last seq it actually sent, and waits. This is
drop-with-marker: the events are still in the durable stream, and your `resume`
collects them.

**Event storms** (a rebalance touching many positions) can be coalesced, per
connection, opt-in:

```json
{ "type": "subscribe", "topics": ["portfolio"], "coalesce": true }
```

Within `WS_COALESCE_WINDOW_MS` (default 250ms), events sharing a
`(topic, type)` collapse to the newest; frames still arrive in ascending `seq`,
coalescing may drop but never reorder.

> **Trade-off, stated plainly.** Suppressed events remain in the durable store
> but will **not** be redelivered by a later `resume`, because your `afterSeq`
> has already moved past them. Use coalescing for a dashboard that only renders
> the latest state; do not use it for anything that must see every event.
> Off by default — this is the client's call, not the server's.

---

## 8. Heartbeat and idle policy

The server pings every `WS_HEARTBEAT_INTERVAL_MS` (default 30s). A connection
that neither pongs nor sends a frame within `WS_IDLE_TIMEOUT_MS` (default 90s)
is closed with code `4408`. Browser clients that cannot observe protocol pongs
can send `{"type":"ping"}` and will receive a `pong`.

### Reconnect policy

Reconnect with exponential backoff and jitter, capped around 30s. Always
`resume` with the highest `seq` you durably processed:

```javascript
let attempt = 0
function reconnect() {
  const delay = Math.min(30_000, 500 * 2 ** attempt++) * (0.5 + Math.random())
  setTimeout(() => open().then(() => { attempt = 0 }), delay)
}
```

On a `draining` frame, wait `retryAfterMs` before reconnecting — the pod is
being replaced and an immediate retry lands on a socket that is also closing.

### Close codes

| Code | Meaning |
|------|---------|
| 1000 | Normal closure |
| 1001 | Server draining (preceded by a `draining` frame) |
| 4401 | Unauthenticated |
| 4403 | Actor not permitted |
| 4408 | Session revoked, or idle timeout |
| 4429 | Message rate limit exceeded |

---

## 9. Privacy

Frames go through the same allowlist discipline as REST responses. Payloads are
projected onto a hand-written per-event-type allowlist
(`mapUserEventPayloadToResponse` in `src/utils/api-formatters.ts`) **before**
they are persisted, so a replay can never hand back a field the live path
stripped.

No `userId`, wallet address, phone, email, key, or internal column appears in a
frame. An event type nobody has reviewed yields an empty payload rather than
being passed through. The connection carries the JWT and nothing else; no secret
ever travels over the socket.

The webhook leg is unchanged and still receives the full payload including
`userId` — an operator's endpoint is a trusted server, an end user's browser is
not.

---

## 10. Architecture

### Unified emission

Every user-facing domain event now goes through one function:

```typescript
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'

await publishUserEvent(
  userId,                                    // or string[] for a multi-user occurrence
  EVENT_TYPE_TOPIC['deposit.received'],
  'deposit.received',
  { txHash, amount, assetSymbol, userId }
)
```

It redacts, persists (allocating `seq`), fans out to sockets locally and across
pods, and dispatches the operator webhook. Adding a domain event therefore
reaches both channels with no bespoke wiring.

The webhook fires **once per domain occurrence** even when the occurrence
touches many users, because webhook subscriptions in this codebase are
operator-scoped, not user-scoped. Only the socket streams fan out per user.

`publishUserEvent` never throws: every call site treats emission as
fire-and-forget precisely because a notification problem must not roll back a
deposit.

### Durable store: Postgres, not Redis Streams

`user_events` + `user_event_sequences`, in Postgres.

Redis is **optional** in this deployment — `src/config/redis.ts` degrades to a
no-op when `REDIS_URL` is unset, which is what most environments and the entire
test suite actually run. A Redis-backed stream would therefore make `resume
afterSeq` silently unavailable exactly where it is hardest to notice, and would
put durability on a store we treat everywhere else as a cache. Postgres is
already the source of truth for every other domain event, is already covered by
the retention job, and gives a gapless per-user counter for free.

`seq` is allocated by a single `INSERT … ON CONFLICT DO UPDATE … RETURNING` on
the counter row, inside the same transaction as the event insert. Concurrent
publishers for the same user serialise on that row lock: no duplicate, and no
hole.

### Retention

Two bounds, both required:

* **Age** — `RETENTION_USER_EVENTS_DAYS` (default 7). This is the one clients
  reason about: offline longer than this means a `gap` and a REST snapshot.
* **Per-user row cap** — `USER_EVENT_STREAM_MAX_PER_USER` (default 5000). Age
  alone would let one pathological account grow without limit inside the window,
  and the promise of a bounded stream is that no single user can do that.

Both are swept by `cleanupUserEvents` in `src/jobs/dataRetention.ts`.

### Multi-instance delivery

Connections live on arbitrary pods; events are produced on arbitrary pods. Every
publish is broadcast on one Redis channel (`WS_EVENT_CHANNEL`), and each pod
delivers to whichever of that user's sockets it holds. An envelope carries the
publishing pod's id so a pod does not redeliver its own emit.

**Loss window.** Redis pub/sub is fire-and-forget, so live cross-pod delivery is
**at-most-once**: an envelope published while a pod is restarting, partitioned,
or slow simply does not reach that pod's sockets. The durable store closes that
window, not the transport — the event was committed with its `seq` before it
reached the bridge, so the client's next `resume afterSeq` collects it in order.

**When Redis is down or unset**, the publish is never dropped silently: it still
reaches this pod's own subscribers, the failure is counted on
`ws_bridge_publish_total{outcome="local_only"|"error"}`, and an alert is raised
through `alertingService` with a stable dedupe key (`ws:bridge:redis-publish-failed`)
so an hour-long outage produces one alert, not one per event.

### Graceful shutdown

Sockets drain **before** `httpServer.close()`. An open WebSocket is a live HTTP
connection, so closing the HTTP server first would block on them until the grace
period expired and then cut them without warning. Instead each client receives a
`draining` frame with the seq to resume after, then a close with code 1001 — a
rolling deploy costs a reconnect, not a REST snapshot. The drain is awaited.

---

## 11. Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `WS_PATH` | `/api/v1/ws` | Upgrade endpoint path |
| `WS_HEARTBEAT_INTERVAL_MS` | `30000` | Ping cadence |
| `WS_IDLE_TIMEOUT_MS` | `90000` | Silence tolerated before close |
| `WS_MAX_BUFFERED_EVENTS` | `256` | Per-connection frame bound |
| `WS_MAX_BUFFERED_BYTES` | `1048576` | Unflushed socket bytes bound |
| `WS_MAX_CONNECTIONS_PER_USER` | `5` | Sockets per user per pod |
| `WS_HANDSHAKE_MAX` / `WS_HANDSHAKE_WINDOW_MS` | `30` / `60000` | Handshake flood guard, per IP |
| `WS_MESSAGE_MAX` / `WS_MESSAGE_WINDOW_MS` | `50` / `10000` | Client message rate |
| `WS_MAX_MESSAGE_BYTES` | `4096` | Largest client frame |
| `WS_REPLAY_MAX_EVENTS` | `1000` | Events one `resume` may replay |
| `WS_SESSION_RECHECK_MS` | `60000` | Live session re-verification |
| `WS_COALESCE_WINDOW_MS` | `250` | Coalescing window (opt-in) |
| `WS_DRAIN_RETRY_AFTER_MS` | `2000` | Advertised reconnect delay |
| `WS_EVENT_CHANNEL` | `neurowealth:user-events` | Redis pub/sub channel |
| `RETENTION_USER_EVENTS_DAYS` | `7` | Stream age bound |
| `USER_EVENT_STREAM_MAX_PER_USER` | `5000` | Stream row bound per user |

---

## 12. Observability

All on the existing Prometheus registry (`/metrics`):

| Metric | Type | Labels |
|--------|------|--------|
| `ws_connections_active` | gauge | `mode` = `self` / `delegated` |
| `ws_handshakes_total` | counter | `outcome` = `accepted` / `unauthorized` / `forbidden` / `rate_limited` / `too_many` |
| `ws_messages_sent_total` | counter | `topic`, `path` = `live` / `replay` |
| `ws_messages_received_total` | counter | `type` |
| `ws_replay_events_total` | counter | — |
| `ws_gaps_total` | counter | `reason` |
| `ws_dropped_events_total` | counter | `reason` = `backpressure` / `coalesced` |
| `ws_bridge_publish_total` | counter | `outcome` = `redis` / `local_only` / `error` |
| `ws_publish_failures_total` | counter | — |

Worth alerting on: a sustained non-zero rate of
`ws_dropped_events_total{reason="backpressure"}` (clients or pods too slow),
`ws_bridge_publish_total{outcome!="redis"}` in a multi-pod deployment (live
delivery is degraded), and any `ws_publish_failures_total` (the durable stream
is not accepting writes, so resume will not close gaps).

---

## 13. Out of scope for v1

* Bidirectional trading messages — receive side is server→client only.
* Compression and tracing beyond what the stack already provides.
