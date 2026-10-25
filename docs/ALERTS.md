# Alert Rules, Acknowledgement, Snooze & Escalation (#366)

NeuroWealth provides user-defined alert rules watching portfolio metrics (`PROTOCOL_APY`, `PORTFOLIO_VALUE`, `POSITION_DRAWDOWN`, `DRIFT`, `VOLATILITY_REGIME`, `ANOMALY`).

## Operational queue alerts

Prometheus rules in `deploy/monitoring/prometheus/alert-rules.yaml` protect the
durable outbox and message-delivery queues. The importable Grafana dashboard is
`deploy/monitoring/grafana/dashboards/queue-health.json`; every panel uses a
metric emitted by `src/utils/metrics.ts` or `src/utils/job-metrics.ts`.

| Alert                                | Trigger                                                      | Response                                                                          |
| ------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `MessageDeliveryDLQGrowing`          | New `message_dead_letters_total` entries over 15 minutes     | Inspect channel/provider errors and follow `MESSAGING_DELIVERY.md`.               |
| `MessageDeliverySuccessRateBelowSLO` | Delivered/total ratio below 99% for 15 minutes               | Break down `message_deliveries_total` by channel and status.                      |
| `OldestPendingOutboxEntryTooOld`     | `queue_lag_seconds{queue_name="outbox"}` exceeds 300 seconds | Inspect outbox workers and follow `OUTBOX.md`; do not bypass idempotent dispatch. |

Validate JSON before provisioning with
`node -e "JSON.parse(require('fs').readFileSync('deploy/monitoring/grafana/dashboards/queue-health.json'))"`.

## Concepts & Control Flow

- **Cooldown (`cooldownMinutes`)**: Restricts re-firing frequency while a condition remains true across consecutive ticks.
- **Snooze (`POST /api/v1/alerts/:id/snooze`)**: Temporarily mutes an alert rule for a duration (clamped to max 30 days). Evaluation is skipped while snoozed, but would-be fires are recorded in `AlertFire` history with `suppressedBySnooze: true` for auditing. Auto-expires emitting `alert.snooze_expired`.
- **Acknowledge (`POST /api/v1/alerts/:id/ack`)**: Marks an alert episode as "seen" by linking an `AlertAck` to `AlertFire` records. Resets the escalation counter. Can be invoked via API or via signed single-use `ackToken` in WhatsApp/Telegram/Email notifications.
- **Escalation**: Triggers when the count of **un-acknowledged** fires (`AlertFire` where `ackId IS NULL`) within a rule's window reaches `escalationThreshold`. Escalated fires set `escalated = true` and deliver to `escalationChannel`.

---

## API Endpoints

| Method | Endpoint                    | Description                                            |
| :----- | :-------------------------- | :----------------------------------------------------- |
| `POST` | `/api/v1/alerts/:id/snooze` | Mute rule for `durationMinutes` or `until` date        |
| `POST` | `/api/v1/alerts/:id/ack`    | Acknowledge alert fire(s) using `fireId` or `ackToken` |
| `GET`  | `/api/v1/alerts/:id/fires`  | View paginated fire history with ack & snooze status   |

## Delete and Restore

Deleting an alert rule through `DELETE /api/v1/alerts/:id` is a soft delete.
The row receives `deletedAt`; it is hidden from owner-facing list and mutation
routes and excluded from scheduled evaluation and Telegram/WhatsApp lists.
The owner can restore it with `POST /api/v1/alerts/:id/restore`. Both actions
require `alerts:manage` and match the rule by both its ID and authenticated
user ID, so another tenant cannot delete or restore it by guessing the ID.

Each successful transition writes a `UserDataAudit` row in the same database
transaction with tenant, actor, record type/ID, action (`DELETE` or `RESTORE`),
and timestamp. Audit rows intentionally do not cascade with user data. The
administrative erasure job remains a separate hard-delete path per the
configured erasure policy.
