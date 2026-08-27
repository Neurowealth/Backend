# Service Level Objectives (SLO) Guidance

This document defines latency budgets and performance targets for critical endpoints, providing clear guidance for monitoring, alerting, and capacity planning.

## Overview

The NeuroWealth backend operates with the following SLO targets:
- **Overall API Availability**: 99.5% (monthly)
- **Critical Endpoint Latency (p95)**: < 500ms
- **Internal Endpoint Latency (p95)**: < 1s
- **Background Job Latency (p95)**: < 30s

## Endpoint Latency Budgets

### Critical Public Endpoints

These endpoints are user-facing and have strict latency requirements.

| Endpoint | Method | SLO (p95) | SLO (p99) | Error Budget | Metric |
|----------|--------|-----------|-----------|--------------|--------|
| `/api/auth/challenge` | POST | 200ms | 500ms | 0.5% | `http_request_duration_seconds{route="/api/auth/challenge"}` |
| `/api/auth/verify` | POST | 200ms | 500ms | 0.5% | `http_request_duration_seconds{route="/api/auth/verify"}` |
| `/api/portfolio` | GET | 300ms | 750ms | 1% | `http_request_duration_seconds{route="/api/portfolio"}` |
| `/api/transactions` | GET | 300ms | 750ms | 1% | `http_request_duration_seconds{route="/api/transactions"}` |
| `/api/vault/build-transaction` | POST | 500ms | 1s | 1% | `http_request_duration_seconds{route="/api/vault/build-transaction"}` |
| `/api/deposit` | POST | 500ms | 1s | 1% | `http_request_duration_seconds{route="/api/deposit"}` |
| `/api/withdraw` | POST | 500ms | 1s | 1% | `http_request_duration_seconds{route="/api/withdraw"}` |

### Internal Endpoints

These endpoints are used by monitoring systems or internal services and have relaxed latency targets.

| Endpoint | Method | SLO (p95) | SLO (p99) | Error Budget | Metric |
|----------|--------|-----------|-----------|--------------|--------|
| `/api/agent/status` | GET | 1s | 2s | 2% | `http_request_duration_seconds{route="/api/agent/status"}` |
| `/api/admin/*` | * | 1s | 2s | 2% | `http_request_duration_seconds{route=~"/api/admin/.*"}` |
| `/api/protocols` | GET | 500ms | 1s | 1% | `http_request_duration_seconds{route="/api/protocols"}` |
| `/api/analytics/*` | GET | 2s | 5s | 5% | `analytics_request_duration_seconds` |

### Health & Metrics Endpoints

| Endpoint | Method | SLO (p95) | SLO (p99) | Error Budget | Metric |
|----------|--------|-----------|-----------|--------------|--------|
| `/health/live` | GET | 50ms | 100ms | 0.1% | `http_request_duration_seconds{route="/health/live"}` |
| `/health/ready` | GET | 50ms | 100ms | 0.1% | `http_request_duration_seconds{route="/health/ready"}` |
| `/metrics` | GET | 100ms | 200ms | 0.5% | `http_request_duration_seconds{route="/metrics"}` |

## Background Job Latency Budgets

| Job | SLO (p95) | SLO (p99) | Error Budget | Metric |
|-----|-----------|-----------|--------------|--------|
| Agent Rebalance Check | 10s | 30s | 5% | `agent_rebalance_checks_total` |
| Agent Balance Snapshot | 30s | 60s | 5% | `agent_snapshot_duration_seconds` |
| Session Cleanup | 5s | 15s | 5% | `background_job_duration_seconds{job="session_cleanup"}` |
| Data Retention | 60s | 120s | 10% | `background_job_duration_seconds{job="data_retention"}` |
| Event Processing (per event) | 1s | 5s | 2% | `events_processing_duration_seconds` |

## Database Operation Latency Budgets

| Operation | SLO (p95) | SLO (p99) | Error Budget | Metric |
|-----------|-----------|-----------|--------------|--------|
| User lookup | 50ms | 100ms | 1% | `db_operation_duration_seconds{operation="user_lookup"}` |
| Transaction insert | 100ms | 250ms | 2% | `db_operation_duration_seconds{operation="transaction_insert"}` |
| Position update | 100ms | 250ms | 2% | `db_operation_duration_seconds{operation="position_update"}` |
| Analytics query | 500ms | 1s | 5% | `db_operation_duration_seconds{operation="analytics_query"}` |

## SLO Interpretation

### Error Budget Calculation

Error budget is the allowable amount of time that a service can fail or degrade without violating the SLO.

**Formula**: `Error Budget = (1 - SLO) × Time Period`

**Example** (99.5% monthly availability):
- Monthly time: 30 days × 24 hours × 60 minutes = 43,200 minutes
- Error budget: (1 - 0.995) × 43,200 = 216 minutes of downtime per month

### SLO Miss Response

| Severity | SLO Miss Duration | Action Required |
|----------|-------------------|-----------------|
| **Critical** | > 5% error budget consumed in 24h | Page on-call, investigate immediately, consider rollback |
| **Warning** | > 2% error budget consumed in 24h | Investigate within 1 hour, prepare incident response |
| **Info** | > 1% error budget consumed in 7 days | Monitor trend, discuss in next standup |

### Sustained SLO Misses

If an endpoint consistently misses its SLO target:

1. **Immediate (0-1 hour)**: 
   - Check for external dependencies (RPC, database, APIs)
   - Review recent deployments for regressions
   - Check for resource exhaustion (CPU, memory, connections)

2. **Short-term (1-24 hours)**:
   - Scale infrastructure if resource-constrained
   - Implement caching for frequently accessed data
   - Optimize database queries (add indexes, rewrite queries)
   - Consider rate limiting to protect degraded endpoints

3. **Long-term (1-7 days)**:
   - Architectural changes (async processing, read replicas)
   - Code refactoring for performance
   - Revisit SLO targets if unrealistic
   - Implement feature flags to disable non-critical paths

## Prometheus Alert Rules

### Critical Latency Alerts

```yaml
groups:
  - name: slo_critical_latency
    interval: 30s
    rules:
      - alert: APICriticalLatencyP95
        expr: |
          histogram_quantile(0.95, 
            sum(rate(http_request_duration_seconds_bucket{route=~"/api/(auth|portfolio|transactions|deposit|withdraw).*"}[5m])) by (le)
          ) > 0.5
        for: 5m
        labels:
          severity: critical
          slo: api_latency_p95
        annotations:
          summary: "Critical API endpoint p95 latency exceeds SLO"
          description: "p95 latency is {{ $value }}s (SLO: 0.5s) for critical endpoints"

      - alert: AuthLatencyP99
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{route=~"/api/auth/.*"}[5m])) by (le)
          ) > 0.5
        for: 5m
        labels:
          severity: critical
          slo: auth_latency_p99
        annotations:
          summary: "Auth endpoint p99 latency exceeds SLO"
          description: "p99 latency is {{ $value }}s (SLO: 0.5s) for auth endpoints"
```

### Warning Latency Alerts

```yaml
  - name: slo_warning_latency
    interval: 30s
    rules:
      - alert: APIWarningLatencyP95
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)
          ) > 1
        for: 10m
        labels:
          severity: warning
          slo: api_latency_p95
        annotations:
          summary: "API endpoint p95 latency elevated"
          description: "p95 latency is {{ $value }}s for route {{ $labels.route }}"

      - alert: DatabaseLatencyP95
        expr: |
          histogram_quantile(0.95,
            sum(rate(db_operation_duration_seconds_bucket[5m])) by (le, operation)
          ) > 0.1
        for: 10m
        labels:
          severity: warning
          slo: db_latency_p95
        annotations:
          summary: "Database operation p95 latency elevated"
          description: "p95 latency is {{ $value }}s for operation {{ $labels.operation }}"
```

### Background Job Alerts

```yaml
  - name: slo_background_jobs
    interval: 1m
    rules:
      - alert: AgentSnapshotSlow
        expr: |
          histogram_quantile(0.95,
            rate(agent_snapshot_duration_seconds_bucket[10m])
          ) > 30
        for: 15m
        labels:
          severity: warning
          slo: agent_snapshot_p95
        annotations:
          summary: "Agent balance snapshot p95 latency exceeds SLO"
          description: "p95 snapshot duration is {{ $value }}s (SLO: 30s)"

      - alert: EventProcessingSlow
        expr: |
          histogram_quantile(0.95,
            rate(events_processing_duration_seconds_bucket[5m])
          ) > 1
        for: 10m
        labels:
          severity: warning
          slo: event_processing_p95
        annotations:
          summary: "Event processing p95 latency exceeds SLO"
          description: "p95 event processing duration is {{ $value }}s (SLO: 1s)"
```

## Grafana Dashboard Queries

### Critical Endpoint Latency Panel

```
# P95 Latency by Critical Endpoint
histogram_quantile(0.95, 
  sum(rate(http_request_duration_seconds_bucket{route=~"/api/(auth|portfolio|transactions|deposit|withdraw).*"}[5m])) by (le, route)
)

# P99 Latency by Critical Endpoint
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{route=~"/api/(auth|portfolio|transactions|deposit|withdraw).*"}[5m])) by (le, route)
)
```

### SLO Compliance Panel

```
# Error Budget Remaining (30-day window)
(
  (1 - 0.995) * 30 * 24 * 3600
  - sum(increase(http_requests_total{status_code=~"5.."}[30d]))
) / ((1 - 0.995) * 30 * 24 * 3600) * 100
```

### Database Latency Heatmap

```
# Database Operation Duration Heatmap
sum(rate(db_operation_duration_seconds_bucket[5m])) by (le, operation)
```

## SLO Review Process

### Monthly SLO Review

1. Calculate actual SLO achievement for the past month
2. Compare against targets
3. Identify top contributors to SLO misses
4. Review error budget consumption
5. Adjust SLO targets if needed (requires engineering approval)

### Quarterly SLO Planning

1. Review SLO targets against business requirements
2. Consider infrastructure changes (scaling, caching, architecture)
3. Update alert thresholds based on new baselines
4. Document any SLO target changes with rationale

## Performance Optimization Guidance

When SLOs are consistently missed, consider these optimizations in order:

### 1. Database Optimization
- Add missing indexes on frequently queried columns
- Optimize slow queries with `EXPLAIN ANALYZE`
- Implement connection pooling tuning
- Consider read replicas for analytics queries

### 2. Caching Strategy
- Cache frequently accessed data (protocol rates, user positions)
- Implement Redis or in-memory caching for hot paths
- Use CDN caching for static responses
- Implement cache invalidation policies

### 3. External API Optimization
- Implement circuit breakers for external RPC calls
- Add request batching where possible
- Use connection pooling for HTTP clients
- Implement retry logic with exponential backoff

### 4. Code-Level Optimization
- Profile slow endpoints with Node.js profiler
- Optimize hot code paths (reduce allocations, use efficient algorithms)
- Implement async processing for non-critical operations
- Use streaming for large payloads

### 5. Infrastructure Scaling
- Increase CPU/memory allocation for containers
- Add horizontal scaling (increase replicas)
- Implement load balancing across multiple instances
- Consider geographic distribution for global users

## References

- **Observability Guide**: See `docs/OBSERVABILITY.md` for detailed monitoring setup
- **Runbook**: See `docs/RUNBOOK.md` for incident response procedures
- **Metrics Reference**: See `src/utils/metrics.ts` for available metrics

## Load Testing

Load tests live in `tests/load/` and are run with [k6](https://k6.io/).

### Scripts

| Script | VUs | Duration | Purpose |
|--------|-----|----------|---------|
| `smoke.js` | 5 | 1 min | Verify basic functionality; must pass before any sustained run |
| `load.js` | 50 | 10 min | Simulate typical production traffic; validates rate limiter and pool |
| `stress.js` | up to 200 | ~11 min | Find the breaking point; thresholds are observational |
| `soak.js` | 20 | 1 hour | Detect memory leaks and connection pool exhaustion |

### Running locally

```bash
# Prerequisites: install k6 (https://k6.io/docs/get-started/installation/)

# Smoke — quick sanity check
npm run test:load:smoke

# Load — typical production simulation
npm run test:load

# Stress — break-point discovery (results captured to results/)
npm run test:load:stress

# Soak — 1-hour leak detection (staging only)
npm run test:load:soak
```

All scripts accept `BASE_URL` and `TEST_JWT` environment variables:

```bash
k6 run tests/load/load.js \
  -e BASE_URL=https://staging.neurowealth.io \
  -e TEST_JWT=eyJ...
```

### Baseline results (docker-compose, local M-series Mac)

Collected against `docker-compose up` with a seeded test database.

| Script | p50 | p95 | p99 | Error rate | Date |
|--------|-----|-----|-----|------------|------|
| smoke | 18 ms | 42 ms | 68 ms | 0 % | 2026-06-27 |
| load | 24 ms | 87 ms | 145 ms | 0 % | 2026-06-27 |
| stress (breaking point: ~140 VUs) | 31 ms | 210 ms | 890 ms | 2.1 % | 2026-06-27 |

> Update this table after each load test run on the target environment.

### SLO thresholds enforced in k6

| Metric | smoke | load | soak |
|--------|-------|------|------|
| `portfolio_latency` p95 | < 500 ms | < 500 ms | < 500 ms |
| `deposit_latency` p99 | < 2 000 ms | < 2 000 ms | — |
| Error rate | < 1 % | < 1 % | < 1 % |
| `sustained_slow_responses` | — | — | < 50 events |

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-27 | Add load testing section with k6 baselines (#259) | - |
| 2026-06-24 | Initial SLO documentation created | - |
