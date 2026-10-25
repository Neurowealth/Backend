# Background Job & DLQ Triage Runbook

## Overview

This runbook documents operator triage procedures for handling background job failures, repeated retries, and Dead Letter Queue (DLQ) volume buildup in the NeuroWealth Backend.

> There are **two independent DLQs** with **two independent thresholds** — do
> not treat them as one system:
>
> | DLQ | What it holds | Threshold source | Default |
> |---|---|---|---|
> | Stellar event-listener DLQ (`DeadLetterQueue`, `dead_letter_events`) | Failed Stellar events awaiting replay | `DLQ_ALERT_THRESHOLD` (`deploy/k8s/configmap.yaml`, `src/config/env.ts#dlq.alertThreshold`) | `50` |
> | Messaging DLQ (`message_deliveries` with `status = DEAD_LETTER`) | Undeliverable Telegram/WhatsApp messages | `MESSAGING_DLQ_ALERT_THRESHOLD` (`src/config/env.ts#messaging.dlqAlertThreshold`) | `5` |
>
> The `dlq_size` / `dlq_alert_active` Prometheus gauges describe the **Stellar**
> DLQ only. Messaging DLQ depth is reported via `message_queue_depth` and the
> `message_dead_letters_total` counter (see `docs/MESSAGING_DELIVERY.md`).

---

## 1. Operational Dashboard & Telemetry

Operators can inspect background job health and queue backlogs in real time via:

- **Admin Dashboard API**: `GET /api/v1/admin/jobs/dashboard` (legacy alias: `GET /api/admin/jobs/dashboard`)
  - Auth: admin API key via `Authorization: Bearer <ADMIN_KEY>` (or legacy `X-Admin-Token` header) — see `src/middleware/adminAuth.ts`.
  - Required scope: `metrics:read` (a `super` key implies it).
- **Prometheus Telemetry Endpoint**: `GET /metrics`
  - `job_success_total{job_name}`: Cumulative successful job executions
  - `job_failure_total{job_name}`: Cumulative unhandled job failures
  - `job_retry_total{job_name}`: Total automatic retry attempts
  - `job_completion_status{job_name}`: 1 = healthy, 0 = exhausted retries
  - `dlq_size`: Current Stellar DLQ size (event-listener dead letters)
  - `dlq_alert_active`: 1 = Stellar DLQ alert threshold exceeded (> `DLQ_ALERT_THRESHOLD`, default 50 items)

---

## 2. Job Failure & Retry Triage Workflow

### Step 1: Identify Failing Jobs

Query `/api/v1/admin/jobs/dashboard` (legacy alias: `/api/admin/jobs/dashboard`; scope `metrics:read`) or filter logs by `[JobScheduler]`.

If `job_completion_status == 0` for any job:
1. Note the specific `job_name` (e.g., `retention_all_jobs`, `recurring_deposits`, `protocol_risk_scoring`).
2. Inspect application error logs:
   ```bash
   grep "[JobScheduler] <job_name> exhausted retries" /var/log/neurowealth/app.log
   ```

### Step 2: Diagnostic Matrix

| Failure Mode | Root Cause | Operator Triage Steps |
|---|---|---|
| Database Connection Timeout | DB pool exhaustion or lock contention | 1. Inspect DB connection pool metrics.<br>2. Check for long-running transactions.<br>3. Verify database instance health. |
| Third-Party API Failure | Rate limiting or downstream outage | 1. Check external provider status.<br>2. Verify API key validity and quota.<br>3. Rely on resilient scheduler automatic backoff. |
| Data Corruption / Schema Drift | Invalid data model or unexpected payload | 1. Inspect failed payload in logs.<br>2. Run `npm run env:parity` or contract drift checks.<br>3. Apply patch or data fix script. |

### Step 3: Manual Execution & Recovery

Once the root cause is resolved, force an immediate retry run of the job or wait for the next scheduled tick. Scheduled jobs automatically resume on the next tick or process restart.

---

## 3. Dead Letter Queue (DLQ) Triage Workflow

> This section covers the **Stellar event-listener DLQ** (threshold
> `DLQ_ALERT_THRESHOLD`, default 50). For undeliverable Telegram/WhatsApp
> messages, use the messaging recovery API in `docs/MESSAGING_DELIVERY.md`
> (`GET /api/v1/admin/messages`, threshold `MESSAGING_DLQ_ALERT_THRESHOLD`,
> default 5) — a different queue, endpoint set, and threshold.

### Step 1: DLQ Alert Triggered (`dlq_size > DLQ_ALERT_THRESHOLD`, default 50)

When a DLQ alert is emitted:
1. Inspect DLQ status breakdown via `/api/v1/admin/jobs/dashboard` (legacy alias: `/api/admin/jobs/dashboard`; scope `metrics:read`).
2. Inspect queued events:
   ```bash
   # Read DLQ status breakdown and pending count
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.neurowealth.io/api/v1/admin/jobs/dashboard
   # Paginated DLQ contents (scope dlq:read):
   curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://api.neurowealth.io/api/v1/admin/dlq?page=1&limit=50"
   ```

### Step 2: DLQ Replay Procedure

The Stellar DLQ has two replay endpoints — pick the right one:

- `POST /api/v1/admin/dlq/retry` (scope `dlq:write`, body `{ "dryRun"?: boolean }`) — retries **all** pending DLQ events.
- `POST /api/v1/admin/dlq/replay` (scope `dlq:write`, body `{ "eventIds": string[], "dryRun"?: boolean }`) — replays a **selected** set of events (max 1000 per call; only `PENDING`/`RETRIED` events are eligible).

To safely replay failed events from the DLQ:

1. **Dry-Run Mode** (Inspect impact before replaying):
   ```bash
   curl -X POST https://api.neurowealth.io/api/v1/admin/dlq/retry \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"dryRun": true}'
   ```

   Or for a selected set:
   ```bash
   curl -X POST https://api.neurowealth.io/api/v1/admin/dlq/replay \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"eventIds": ["<dlq-event-id-1>", "<dlq-event-id-2>"], "dryRun": true}'
   ```

2. **Execute Replay**:
   ```bash
   curl -X POST https://api.neurowealth.io/api/v1/admin/dlq/retry \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"dryRun": false}'
   ```

   Or for a selected set:
   ```bash
   curl -X POST https://api.neurowealth.io/api/v1/admin/dlq/replay \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"eventIds": ["<dlq-event-id-1>", "<dlq-event-id-2>"], "dryRun": false}'
   ```

3. **Verify DLQ Normalization**:
   Confirm `dlq_size` drops back below threshold and `dlq_alert_active` resets to `0`.
