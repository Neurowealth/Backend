# Real-Time Streaming (WebSocket & Server-Sent Events) (#369)

NeuroWealth provides two real-time event streaming transports backed by a shared event hub, topic authorization model, and durable per-user sequence stream (`UserEvent`):

1. **WebSocket (`/api/v1/ws`)**: Full-duplex transport suitable for interactive applications.
2. **Server-Sent Events (`/api/v1/stream/sse`)**: Plain HTTP GET fallback transport ideal for environments where WebSockets are blocked (corporate proxies, edge runtimes, curl/script consumers).

---

## Transport Comparison

| Feature | WebSocket (`/api/v1/ws`) | Server-Sent Events (`/api/v1/stream/sse`) |
| :--- | :--- | :--- |
| **Protocol** | `ws://` / `wss://` | Standard HTTP `GET` (`text/event-stream`) |
| **Authentication** | `Authorization: Bearer <token>` or `Sec-WebSocket-Protocol` | `Authorization: Bearer <token>` or `?ticket=<token>` |
| **Resume & Replay** | Control message `resume` with `afterSeq` | `Last-Event-ID` header or `?afterSeq=` query param |
| **Heartbeat** | WS Ping/Pong frames | `: keep-alive\n\n` comments every 15s |
| **Backpressure** | Connection drop on overflow | Connection drop on overflow (`event: overflow`) |

---

## Stream Ticket Authentication Flow

Browsers using standard `EventSource` cannot set custom HTTP headers. To prevent putting live session tokens in URLs, clients obtain a single-use stream ticket:

1. **Issue Ticket**: `POST /api/v1/stream/ticket` (authenticated via Bearer JWT)
   - Returns: `{ "ticket": "eyJ...", "ttlSeconds": 60 }`
2. **Connect SSE**: `new EventSource('/api/v1/stream/sse?topics=portfolio,agent&ticket=eyJ...')`
3. Ticket is **single-use**, expires in **60 seconds**, and grants **read-only topic access**.

---

## Resumable Replay & Event Formatting

SSE events follow standard EventSource framing:

```http
id: 1042
event: deposit.received
data: {"amount": 100, "asset": "USDC", "status": "CONFIRMED"}

: keep-alive
```

- **`id:`**: Monotonic durable sequence number (`seq`).
- **`Last-Event-ID`**: When reconnecting, browsers automatically send `Last-Event-ID: 1042`. The server replays missed events from `seq > 1042`.
- **`event: replay_truncated`**: Emitted if `Last-Event-ID` is older than the server's data retention window.

---

## Example `curl` Usage

```bash
# 1. Get stream ticket
TICKET=$(curl -s -X POST http://localhost:3000/api/v1/stream/ticket \
  -H "Authorization: Bearer $SESSION_TOKEN" | jq -r .ticket)

# 2. Connect to SSE stream
curl -N "http://localhost:3000/api/v1/stream/sse?topics=portfolio,transactions&ticket=$TICKET"
```
