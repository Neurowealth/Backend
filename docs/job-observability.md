# Background Job Observability

This document covers the dedicated observability metrics for scheduled background jobs in the NeuroWealth Backend.

## Metrics Reference

### `job_success_total{job_name}`

- **Type:** Counter
- **Description:** Increments once each time a background job completes without throwing an error.
- **When it increments:** On the successful path of each job function, after the database operation returns.

### `job_failure_total{job_name}`

- **Type:** Counter
- **Description:** Increments once each time a background job throws an unhandled error.
- **When it increments:** Inside the `catch` block of each job function. The recorder then throws `JobFailedError` so the scheduler can resume the run.

### `job_duration_ms{job_name}`

- **Type:** Histogram
- **Description:** Observed duration of each job run, measured in milliseconds from start to finish (including any DB call latency).
- **Buckets (ms):** 100, 500, 1000, 2000, 5000, 10000, 30000, 60000
- **Normal range:** Most retention jobs complete in < 1000 ms under normal load. Spikes above 5000 ms indicate slow DB queries.

### `job_completion_status{job_name}`

- **Type:** Gauge
- **Description:** Terminal status of the last scheduler run. `1` means the last attempt succeeded. `0` means retries were exhausted.
- **When it changes:** Once per scheduler run, after the final attempt. Intermediate retries do not move it.

### `job_retry_total{job_name}`

- **Type:** Counter
- **Description:** Automatic resume attempts after a failed run, before the terminal success or exhausted failure.

## Retries and automatic resume

Scheduled maintenance jobs go through `scheduleResilientJob` in `src/jobs/resilientScheduler.ts`.

- **Cross-pod tick lock (#636):** each tick takes a `pg_try_advisory_xact_lock` keyed by the job name before running. In a multi-replica deployment exactly one pod wins each tick; the others skip (log: `skipped; another replica holds the tick lock`). The lock is released when the wrapping transaction ends.
- Each job runs once at process start, so work that was due while the process was down is resumed immediately.
- A thrown failure is retried up to 3 times with full-jitter exponential backoff (1s base, 30s cap).
- A tick that arrives while a run is still in flight does not start a second run. If that run succeeds, the skipped tick is resumed once. If retries were exhausted, the next interval is the resume point. The scheduler does not tight-loop a job that is still failing.
- Retry timers do not keep the process alive after shutdown clears the interval.

## Failure paths

| Path                                                      | What happens                                                                                                                                                                                                                                                                       | What to do                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient DB or RPC error inside a sweep                  | The attempt increments `job_failure_total`, then the scheduler resumes it after backoff.                                                                                                                                                                                           | If `job_completion_status == 0`, read the `[JobScheduler] <job> exhausted retries` log, fix the dependency, and wait for the next interval or restart.                             |
| Process crash mid-run                                     | The in-memory attempt is gone. The next process runs every job immediately.                                                                                                                                                                                                        | Confirm `job_completion_status` becomes `1` after startup. Recurring deposits have an extra step below.                                                                            |
| Overlapping tick                                          | The second tick is deferred, not run in parallel.                                                                                                                                                                                                                                  | Expected for a slow sweep. Investigate if duration stays above the interval.                                                                                                       |
| Retention sweep, one table fails                          | Later retention steps still run. The sweep then fails and the whole idempotent pass is resumed.                                                                                                                                                                                    | The child series (`retention_auth_nonces`, `retention_processed_events`, `retention_dead_letter_events`, `retention_agent_logs`, `retention_user_events`) shows which step failed. |
| Portfolio risk, some users fail                           | The rest of the pass still completes. Any user/window failure fails the sweep so the upsert is resumed. After 3 attempts an operational alert is emitted.                                                                                                                          | Inspect `[PortfolioRisk] Failed to precompute for user/window`.                                                                                                                    |
| Recurring deposit, one plan fails                         | That plan stays `ACTIVE` with `nextRunAt` unchanged and is tried on the next sweep. Other plans are not rolled back.                                                                                                                                                               | Check `lastRunStatus` on `recurring_deposit_plans`.                                                                                                                                |
| Recurring deposit crash while `lastRunStatus = executing` | For 10 minutes the claim is treated as in flight. After that, a `CONFIRMED` deposit with memo `recurring-deposit:<planId>` completes the plan without a second submission. A `PENDING` deposit is left to the outbox. No matching deposit means the occurrence is submitted again. | Do not clear `executing` by hand while a deposit for that memo is still `PENDING`.                                                                                                 |
| Alert-rule or reserve-reconciliation row error            | The row is logged and the sweep continues. The next tick retries that row. The sweep retries with backoff only when the whole pass throws.                                                                                                                                         | A single bad row should not page. A sweep-level `job_completion_status == 0` should.                                                                                               |
| Pool metrics API unavailable                              | The poll returns without failing. Gauges keep their last value.                                                                                                                                                                                                                    | Confirm the Prisma metrics preview feature is enabled before treating a flat gauge as healthy.                                                                                     |

## Job Names

| `job_name` label               | Description                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `retention_auth_nonces`        | Deletes expired rows from `auth_nonces`                                          |
| `retention_processed_events`   | Prunes `processed_events` older than the configured retention window             |
| `retention_dead_letter_events` | Removes RESOLVED `dead_letter_events` older than the configured retention window |
| `retention_agent_logs`         | Prunes `agent_logs` older than the configured retention window                   |
| `session_cleanup`              | Deletes expired rows from `sessions`                                             |
| `retention_all_jobs`           | Sequential retention sweep. Completion status is recorded on this name           |
| `retention_user_events`        | Prunes per-user event streams past the retention window                          |
| `fiat_reconciliation`          | Settles processing fiat orders and ages out stale pending orders                 |
| `referral_payout`              | Pays activated referral conversions that are not yet rewarded                    |
| `recurring_deposits`           | Executes due recurring deposit plans                                             |
| `approval_expiry_sweep`        | Expires pending approval requests past `expiresAt`                               |
| `alert_rules`                  | Evaluates user price and yield alert rules                                       |
| `strategy_metrics`             | Refreshes strategy marketplace metrics                                           |
| `protocol_risk_scoring`        | Recomputes protocol risk scores                                                  |
| `allocation_suggestions`       | Recomputes portfolio allocation suggestions                                      |
| `performance_attribution`      | Recomputes benchmark-relative performance attribution                            |
| `portfolio_risk`               | Precomputes per-user portfolio risk aggregates                                   |
| `reserve_reconciliation`       | Compares reserve sponsorship rows with on-chain sponsor state                    |
| `pool_metrics`                 | Mirrors Prisma pool gauges into Prometheus                                       |

## Concurrency classification (#636)

Every scheduled job is classified for what would happen *without* the tick lock.
Source of truth: `src/jobs/jobClassification.ts` — `tests/unit/jobs/jobClassification.test.ts`
fails if a `jobName` in `src/jobs/` is missing a row.

| Class | Meaning |
| --- | --- |
| `locked` | Money-moving or destructive; must never run twice. |
| `idempotent-by-design` | Safe to run twice (upsert / recompute). |
| `safe-to-run-concurrently` | Designed for parallel runs (read + emit only). |

| Job | Class | Notes |
| --- | --- | --- |
| `alert_rules` | idempotent-by-design | Re-evaluates rules; alerts are deduped |
| `allocation_suggestions` | idempotent-by-design | Recomputes suggestions |
| `approval_expiry_sweep` | locked | Expires approvals; double-run races the expiry write |
| `fiat_reconciliation` | locked | Settles fiat orders; money-moving |
| `linked_external_wallet_sync` | idempotent-by-design | Refreshes wallet snapshots |
| `loan-accrual` | idempotent-by-design | Accrual is safe to apply twice on two replicas by design |
| `loan-liquidation-monitor` | locked | Triggers liquidations; money-moving |
| `message_delivery_sweep` | idempotent-by-design | Re-delivers undelivered messages |
| `performance_attribution` | idempotent-by-design | Recomputes attribution windows |
| `pool_metrics` | safe-to-run-concurrently | Read-only gauge mirror |
| `portfolio_risk` | idempotent-by-design | Upserts risk aggregates |
| `protocol_risk_scoring` | idempotent-by-design | Recomputes scores |
| `recurring_deposits` | locked | Submits deposits; money-moving |
| `recurring_withdrawals` | locked | Submits withdrawals; money-moving |
| `referral_payout` | locked | Pays referral rewards; money-moving |
| `reserve_reconciliation` | idempotent-by-design | Reconciles sponsor state |
| `retention_all_jobs` | locked | Destructive deletes |
| `risk_metadata_staleness` | idempotent-by-design | Marks stale metadata |
| `session_cleanup` | locked | Destructive deletes |
| `stellar_signer_rotation` | locked | Rotates signers; must not interleave |
| `strategy_metrics` | idempotent-by-design | Refreshes marketplace metrics |
| `support_ticket_sla` | idempotent-by-design | Updates SLA fields |

## Accessing Metrics

The `/metrics` endpoint is internal and requires a valid bearer token:

```
GET /metrics
Authorization: Bearer <METRICS_TOKEN>
```

Set `METRICS_TOKEN` in the environment. Prometheus should be configured to pass this header when scraping.

## Dashboard Panels (Grafana PromQL Examples)

```promql
# Success rate per job (last 1h)
rate(job_success_total[1h])

# Failure rate per job (last 1h)
rate(job_failure_total[1h])

# P95 job duration
histogram_quantile(0.95, rate(job_duration_ms_bucket[1h]))

# Jobs that have failed in the last 24h
increase(job_failure_total[24h]) > 0

# Last run did not complete successfully
job_completion_status == 0

# Automatic resumes after a failed attempt
rate(job_retry_total[1h])
```

## Alert Suggestions

```yaml
# Alert: job failing repeatedly
- alert: BackgroundJobFailing
  expr: increase(job_failure_total[1h]) > 3
  for: 0m
  labels:
    severity: warning
  annotations:
    summary: 'Background job {{ $labels.job_name }} failing'
    description: 'Job {{ $labels.job_name }} has failed more than 3 times in the last hour.'

# Alert: job taking too long
- alert: BackgroundJobSlow
  expr: histogram_quantile(0.95, rate(job_duration_ms_bucket[1h])) > 30000
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: 'Background job {{ $labels.job_name }} is slow (p95 > 30s)'
```

## Troubleshooting

- **Job not appearing in metrics:** The job has not yet run since the last process start. Metrics are emitted lazily on first execution. Check that the job is scheduled (look for the scheduler startup log line).
- **All jobs failing:** Most likely a database connectivity issue. Check DB connection pool health and `db_connections_active` metric.
- **Duration spike on a specific job:** Run `EXPLAIN ANALYZE` on the DELETE query for the affected table. Check for missing indexes on `expiresAt`, `processedAt`, or `createdAt` columns.
