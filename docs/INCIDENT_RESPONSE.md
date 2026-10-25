# Production Incident Response

How on-call responds to core service and infrastructure alerts, who owns the next step, and how a postmortem is filed. Alert rules live in `deploy/monitoring/prometheus/alert-rules.yaml`. Contacts in this document match [RUNBOOK.md § Incident Contacts](./RUNBOOK.md).

## Open an incident

1. Acknowledge the PagerDuty page. Routing uses `PAGERDUTY_ROUTING_KEY` from the alerting service (`src/services/alerting.ts`).
2. Open a thread in `#neurowealth-incidents` with the alert name, severity, start time (UTC), and a one-line impact statement. Automated pages also land in `#neurowealth-alerts`.
3. The acknowledging engineer is the incident lead (T1) until they hand off in the thread.
4. Post a status update in that thread at least every 30 minutes for SEV1 and every hour for SEV2 until the alert clears.

`ops@neurowealth.io` is the backup contact when PagerDuty or Slack is unreachable.

## Severity and escalation

| Severity | Examples | Ack | Next escalation |
|---|---|---|---|
| **SEV1** | Agent loop stopped, global circuit breaker open, event processing halted, funds at risk, data loss, sponsor XLM exhausted | 15 min | Page T2 at 15 min if unacked. Page T3 at 30 min if still unmitigated. Page T4 immediately for key compromise, unauthorized withdrawal, or wallet recovery. |
| **SEV2** | Cursor lag > 100, DLQ > 50, agent loop degraded, repeated DB pool saturation | 1 hour | Page T2 if not mitigated within 1 hour. |
| **SEV3** | Cursor lag > 50, DLQ > 20, slow HTTP or DB, single protocol/user breaker | 8 hours | T1 only. |
| **SEV4** | Informational, single noisy series | Next business day | No page. Note it in `#neurowealth-alerts`. |

| Tier | Role | Owns | Reach them |
|---|---|---|---|
| T1 | On-call engineer | Ack, triage, restart, DLQ retry, RPC rotation, sponsor top-up | PagerDuty |
| T2 | Backend lead | Code fix, data reconciliation, migration rollback | Slack `@backend-lead`, then PagerDuty if they do not answer in the severity window |
| T3 | Engineering manager | Stakeholder updates, priority, postmortem acceptance for SEV1 | Slack `@eng-mgr` |
| T4 | Security officer | Key compromise, wallet recovery, audit | Slack `@sec-officer` |

Hand off by naming the new lead in the incident thread and confirming they have acknowledged.

## Core service alerts

### `AgentLoopStopped` (critical)

`agent_loop_status == 0` for 1 minute. Rebalance, snapshot, and the daily protocol scan are not scheduled.

1. `curl -s http://localhost:3001/health/ready | jq '.subsystems'`
2. Check pod logs for `Failed to start agent loop` and for an uncaught exception (the process exits on `uncaughtException`).
3. Restart the pod if the process is up but the loop is stopped. Confirm `agent_loop_status` returns to running and the heartbeat moves.
4. If it stops again, page T2. Do not leave rebalancing down through the next hourly tick.

### `AgentLoopHeartbeatStale` (critical)

Heartbeat older than 5 minutes. The loop may be wedged even if status still says running.

1. Compare `agent_loop_heartbeat_timestamp` with wall clock.
2. Look for a stuck Soroban submit or a DB call that never returned.
3. Restart if the heartbeat does not move within one probe interval after the stuck call is identified.
4. SEV1 while user funds can still be rebalanced against a stale view.

### `AgentLoopDegraded` (warning)

`agent_loop_status == 2` for 5 minutes. The loop is up but a dependency is unhealthy.

1. Read the degraded reason in the agent logs.
2. If the cause is RPC, follow [RUNBOOK.md § RPC Failover](./RUNBOOK.md).
3. Escalate to SEV2 if it lasts past an hour.

### `CursorLagWarning` / `CursorLagCritical`

Warning above 50 ledgers for 5 minutes. Critical above 100 ledgers for 2 minutes.

Follow [RUNBOOK.md § Ledger Lag Alerts](./RUNBOOK.md). Critical lag is SEV2. Warning lag is SEV3 unless it is still climbing, in which case treat it as SEV2.

### `DLQSizeWarning` / `DLQSizeCritical`

Warning above 20 events for 5 minutes. Critical above 50 for 1 minute.

Follow [DLQ_ALERTING_RUNBOOK.md](./DLQ_ALERTING_RUNBOOK.md) and [RUNBOOK.md § DLQ Replay](./RUNBOOK.md). Critical DLQ size is SEV2. Do not replay until a sample event has been inspected.

### `HighFailureRate` (critical)

`rate(failures_total[5m]) > 10` for 5 minutes.

1. Split the series by label if Prometheus has one; otherwise read the error logs for the same window.
2. If failures are event processing, check DLQ growth and cursor lag before restarting.
3. If failures are background jobs, see `job_completion_status == 0` and [job-observability.md](./job-observability.md).
4. Page T2 when the rate is still above the threshold after the obvious dependency (DB, RPC) is healthy.

### `AgentBreakerGlobalOpen` (critical) / `AgentBreakerOpen` (warning)

Global open means all agent rebalancing is halted. A non-global open halts one protocol or one user. Withdrawals are not blocked.

Follow [RUNBOOK.md § Agent Circuit Breaker](./RUNBOOK.md). A global open is SEV1 until the trip rule is understood. Reset only after the underlying condition is gone. Manual breakers do not auto-reset.

## Infrastructure alerts

### Pod liveness and readiness

- Liveness is `GET /health/live`. Three failures and kubelet restarts the pod. A restart loop usually means the process is exiting (`uncaughtException` / `unhandledRejection`) or failing its memory limit.
- Readiness is `GET /health/ready`. HTTP 503 removes the pod from the Service. The body lists `database`, `eventListener`, and `agentLoop`. All three must be ready before traffic returns.
- `deploy/k8s/deployment.yaml` currently probes `/health/deep`. The application serves `/health/live` and `/health/ready` ([HEALTH_ENDPOINTS.md](./HEALTH_ENDPOINTS.md)). If a new pod never becomes Ready, compare the probe path with those routes before chasing the database.

### `DatabaseOperationsSlow` (warning)

P95 `db_operation_duration_seconds` above 1 second for 5 minutes.

1. `psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"`
2. Look for lock waits and for a retention or reconciliation job running long (`job_duration_ms`).
3. SEV3 unless the pool is also saturated or `/health/ready` is 503, which is SEV2.

### `DBPoolSaturation` (warning)

`db_pool_wait_count > 5` for 30 seconds. Queries are waiting on a Prisma connection.

1. Check `db_pool_active`, `db_pool_idle`, and `db_pool_size` from `/metrics`.
2. Find the slow query before raising `DATABASE_CONNECTION_LIMIT`. A larger pool hides a stuck transaction.
3. If `/health/ready` goes 503, treat it as SEV2 and page T2.

### `HTTPRequestsSlow` (warning)

P95 HTTP duration above 5 seconds for 5 minutes.

1. Separate `/health/*` from user routes. Health slowness points at the DB or the agent loop.
2. Check connection pool saturation and RPC timeouts.
3. SEV3 unless error rate or readiness is also failing.

### `SponsorLowXlm` (critical)

A sponsor account has been under 10 XLM for 5 minutes. New sponsored reserves will fail.

Follow [RUNBOOK.md § Sponsor Account Top-Up](./RUNBOOK.md). This is SEV1 if account creation or deposits are failing, otherwise SEV2 until the top-up is confirmed on `/metrics` (`sponsor_available_xlm`).

### `FeeOracleStale` (warning) / `SevereCongestion` (warning)

The fee oracle has not updated for more than 60 seconds, or congestion has been severe for 5 minutes. Low-priority outbox ops defer in severe congestion.

1. Check RPC health ([RUNBOOK.md § RPC Failover](./RUNBOOK.md)).
2. Do not force-submit deferred low-priority ops while congestion is severe.
3. SEV3 unless submits are failing user withdrawals, which is SEV2.

## Postmortem workflow

A postmortem is part of closing the incident, not a follow-up someone might remember later.

| Incident | Postmortem |
|---|---|
| SEV1 | Required. Draft within 3 business days. T3 accepts it. |
| SEV2 | Required. Draft within 3 business days. T2 accepts it. |
| SEV3 | Required only when the same alert fires 3 times in 7 days. |
| SEV4 | Not required. |

The incident lead writes it. The reviewer is the tier that accepted the escalation, or T2 if nobody else was paged.

File it at `docs/post-mortems/YYYY-MM-DD-short-title.md` with:

1. **Summary** — what broke, in one paragraph.
2. **Impact** — who was affected, for how long, and whether funds or data were at risk.
3. **Timeline** — UTC timestamps from detection through mitigation.
4. **Root cause** — the change or failure that made the alert fire.
5. **Detection** — which alert fired, and how long the fault existed before it.
6. **What worked / what did not** — including any runbook step that was wrong or missing.
7. **Action items** — owner and a GitHub issue link for each. One of them updates this document or `docs/RUNBOOK.md` when a step was missing.

The review is blameless. The incident stays open in `#neurowealth-incidents` until the postmortem is merged and the paging alert has stayed clear.
