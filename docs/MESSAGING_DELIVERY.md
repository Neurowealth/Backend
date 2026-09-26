# Telegram & WhatsApp Message Delivery Architecture (#493)

## Overview

NeuroWealth provides high-reliability, observable message delivery for Telegram bot communications and WhatsApp notifications. The messaging subsystem tracks message lifecycle statuses, enforces exponential backoff with jitter and provider rate-limit compliance, supports automated cross-channel fallback, and provides admin endpoints for safe manual recovery of failed or dead-lettered messages.

---

## Delivery Status Lifecycle

All outbound messages are tracked in the `MessageDelivery` table with the following lifecycle states:

```
[ PENDING ] ───▶ [ SENDING ] ───▶ [ DELIVERED ]
      ▲                │
      │ (retry)        ▼
      └── [ RETRYING ] ◀─── (transient failure: 429, 5xx, network timeout)
                       │
                       ▼ (attempts exhausted or permanent failure)
                  [ DEAD_LETTER ] ───▶ [ Manual Recovery / Cancel ]
```

- **`PENDING`**: Message is queued and awaiting dispatch or scheduled for a future retry attempt (`nextAttemptAt`).
- **`SENDING`**: Message is actively being delivered via provider API.
- **`DELIVERED`**: Message successfully accepted by provider; records `providerMessageId` (Telegram message ID or Twilio Message SID) and `deliveredAt` timestamp.
- **`FAILED`**: Explicitly cancelled or marked unrecoverable.
- **`DEAD_LETTER`**: Message exhausted all retries or experienced a fatal non-transient error (e.g. 400 Bad Request, 403 Forbidden / bot blocked, invalid phone number). Alert triggers automatically if DLQ threshold is breached.

---

## Retry & Fallback Policy

### 1. Transient Error Detection & Provider Backoff
- **Telegram**:
  - Automatically parses HTTP 429 response `parameters.retry_after` and extracts seconds.
  - Classifies HTTP 429, 500, 502, 503, 504, `ECONNRESET`, `ETIMEDOUT`, and network errors as transient.
  - Treats 400 (Bad Request), 403 (Forbidden: bot blocked by user), and 404 as non-transient / terminal.
- **WhatsApp (Twilio)**:
  - Parses Twilio error codes (e.g. 20429 rate limit, 503 service unavailable, 21614 message queue saturation).
  - Inspects `Retry-After` headers if returned.
  - Treats 21211 (Invalid 'To' phone number), 21610 (Blacklisted recipient), and 21617 as non-transient.

### 2. Exponential Backoff with Jitter
For retriable errors, the next attempt timestamp is calculated as:
$$\text{delay} = \min(\text{maxDelayMs}, \text{baseDelayMs} \times 2^{\text{attempts}-1}) \times (1 + \text{jitter})$$
where $\text{jitter} \in [0, 0.25]$ to prevent thundering herd spikes. If provider provides `retry_after`, $\max(\text{delay}, \text{retryAfterMs})$ is respected.

### 3. Cross-Channel Fallback
When configured (`MESSAGING_FALLBACK_ENABLED=true`):
- If delivery fails permanently on the primary channel, the engine checks for a linked user account or configured fallback recipient:
  - `TELEGRAM` ──▶ `WHATSAPP` (using user's verified phone number)
  - `WHATSAPP` ──▶ `TELEGRAM` (using user's linked Telegram chat ID)
- Fallback dispatches record `fallbackTriggered = true`, `fallbackChannel`, and `fallbackRecipient`, emitting `message_fallbacks_total` metrics.

---

## Background Sweep Job

The background sweep worker (`src/jobs/messageDeliverySweep.ts`) runs at configured intervals (default: 30 seconds):
- Scans for `PENDING` messages where `nextAttemptAt <= NOW()`.
- Dispatches messages ordered by priority (`CRITICAL`, `HIGH`, `NORMAL`, `LOW`) and creation date.
- Emits queue depth metrics (`message_queue_depth`) for Prometheus monitoring.
- Triggers alerting via `alertingService` if dead-lettered message count exceeds `MESSAGING_DLQ_ALERT_THRESHOLD`.

---

## Metrics & Observability

Prometheus metrics exposed at `/metrics`:

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `message_deliveries_total` | Counter | `channel`, `status`, `category` | Total delivery attempts by status (`DELIVERED`, `RETRYING`, `DEAD_LETTER`, `DELIVERED_FALLBACK`) |
| `message_retries_total` | Counter | `channel` | Total retries scheduled |
| `message_fallbacks_total` | Counter | `from_channel`, `to_channel` | Total cross-channel fallback events triggered |
| `message_dead_letters_total` | Counter | `channel`, `reason` | Total messages moved to dead letter queue |
| `message_queue_depth` | Gauge | `channel`, `status` | Current number of messages in pending or dead letter states |
| `message_delivery_duration_seconds` | Histogram | `channel` | Latency distribution of message delivery requests |

---

## Safe Manual Recovery Admin API

Authenticated administrators with `messages:read` or `messages:write` scopes can safely monitor and recover failed messages via the Admin API:

### 1. List Messages
`GET /api/v1/admin/messages?status=DEAD_LETTER&channel=TELEGRAM&page=1&limit=50`
- Query parameters: `status`, `channel`, `userId`, `page`, `limit`.
- Returns paginated list of tracked message deliveries.

### 2. Queue & Delivery Statistics
`GET /api/v1/admin/messages/stats`
- Returns summary counts of messages by status and per channel breakdown (pending, delivered, dead-lettered).

### 3. Inspect Single Message
`GET /api/v1/admin/messages/:id`
- Returns full details including attempt history, last error message, provider IDs, and fallback status.

### 4. Single Message Recovery
`POST /api/v1/admin/messages/:id/retry`
- Resets attempts counter and immediately triggers safe re-dispatch.
- Logs administrative audit entry (`action: MESSAGE_RETRY`).

### 5. Bulk Dead-Letter Queue Recovery
`POST /api/v1/admin/messages/retry-dead-letters`
- Payload: `{ "channel": "TELEGRAM" }` (optional filter).
- Resets all matching `DEAD_LETTER` messages to `PENDING` with immediate `nextAttemptAt` for the background worker to safely sweep with rate-limiting.
- Logs administrative audit entry (`action: MESSAGE_RETRY_DEAD_LETTERS`).

### 6. Cancel Pending/Dead Message
`DELETE /api/v1/admin/messages/:id`
- Transitions message to `FAILED` with `lastError: "Cancelled by administrator"`.
- Prevents any further background retry attempts.
- Logs administrative audit entry (`action: MESSAGE_CANCEL`).

---

## Configuration Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | String | - | Telegram Bot API token |
| `MESSAGING_MAX_RETRIES` | Number | `5` | Maximum delivery attempts before moving to DLQ |
| `MESSAGING_RETRY_BASE_DELAY_MS` | Number | `2000` | Initial exponential backoff delay (ms) |
| `MESSAGING_RETRY_MAX_DELAY_MS` | Number | `300000` | Maximum backoff delay cap (5 minutes) |
| `MESSAGING_SWEEP_INTERVAL_MS` | Number | `30000` | Background retry sweep interval (30 seconds) |
| `MESSAGING_FALLBACK_ENABLED` | Boolean | `true` | Enable automated cross-channel fallback (Telegram ↔ WhatsApp) |
| `MESSAGING_DLQ_ALERT_THRESHOLD` | Number | `10` | Dead-letter threshold triggering high-priority alerts |
