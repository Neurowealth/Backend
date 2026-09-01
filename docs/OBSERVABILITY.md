# Observability & Monitoring Guide

This document provides production-grade observability guidance including alert thresholds, Grafana dashboard recommendations, and deployment best practices for the NeuroWealth backend.

**Related Documentation**:
- **SLO Guidance**: See `docs/SLO_GUIDANCE.md` for latency budgets and performance targets
- **Runbook**: See `docs/RUNBOOK.md` for incident response procedures

## Overview

The backend exposes Prometheus-compatible metrics through the `/metrics` endpoint, providing comprehensive visibility into:
- Event processing (deposits, withdrawals, rebalances)
- Dead Letter Queue (DLQ) size and retry status
- Cursor lag and ledger processing
- Agent loop heartbeat and health
- Database operation performance
- HTTP request metrics
- Analytics API performance

## Prometheus Metrics

### Event Processing Metrics

- `events_processed_total` - Counter with labels: `event_type`, `status`
- `events_processing_duration_seconds` - Histogram with label: `event_type`
- `events_processing_rate_per_minute` - Gauge

### Failure Metrics

- `failures_total` - Counter with labels: `component`, `error_type`
- `failure_rate` - Gauge

### Dead Letter Queue Metrics

- `dlq_size` - Gauge (current number of failed events)
- `dlq_retry_total` - Counter with label: `status`

### Cursor/Lag Metrics

- `cursor_lag_ledgers` - Gauge (latest ledger - last processed ledger)
- `last_processed_ledger` - Gauge

### Agent Loop Metrics

- `agent_loop_heartbeat_timestamp` - Gauge (Unix timestamp)
- `agent_loop_status` - Gauge (0=stopped, 1=running, 2=degraded)
- `agent_rebalance_checks_total` - Counter with label: `status`
- `agent_rebalances_triggered_total` - Counter
- `agent_snapshot_duration_seconds` - Histogram

### Agent Circuit Breaker Metrics (#345)

- `agent_breaker_state` - Gauge, labels `scope` (`GLOBAL`|`PROTOCOL`|`USER`) and `scopeKey`; 0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN. Written every agent breaker evaluation tick and on every transition.
- `agent_breaker_trips_total` - Counter, labels `scope`, `rule` (`abnormal_loss`|`depeg`|`oscillation`|`stale_data`|`manual`). Increments whenever a breaker trips or re-trips.

Query examples:

```
# Any circuit breaker open right now
agent_breaker_state == 2

# Global halt (stops all agent rebalancing)
agent_breaker_state{scope="GLOBAL"} == 2

# Breaker trip rate by rule
sum(rate(agent_breaker_trips_total[15m])) by (rule)
```

### Database Metrics

- `db_operation_duration_seconds` - Histogram with label: `operation`
- `db_connections_active` - Gauge

### HTTP Request Metrics

- `http_requests_total` - Counter with labels: `method`, `route`, `status_code`
- `http_request_duration_seconds` - Histogram with labels: `method`, `route`, `status_code`

### Analytics API Metrics

- `analytics_requests_total` - Counter with labels: `endpoint`, `status`
- `analytics_request_duration_seconds` - Histogram with label: `endpoint`

## Recommended Alert Thresholds

### Critical Alerts (Page Immediately)

| Metric | Condition | Severity | Description |
|--------|-----------|----------|-------------|
| `agent_loop_status` | `== 0` (stopped) | Critical | Agent loop is not running |
| `agent_loop_heartbeat_timestamp` | `> 5 minutes ago` | Critical | Agent loop heartbeat stale |
| `cursor_lag_ledgers` | `> 100` | Critical | Event processing lagging significantly |
| `dlq_size` | `> 50` | Critical | Dead Letter Queue critically large |
| `failures_total` (rate) | `> 10 per minute` for 5m | Critical | High failure rate |
| `agent_breaker_state{scope="GLOBAL"}` | `== 2` for 1m | Critical | Global circuit breaker OPEN — all rebalancing halted |

### Warning Alerts (Investigate Within 1 Hour)

| Metric | Condition | Severity | Description |
|--------|-----------|----------|-------------|
| `agent_loop_status` | `== 2` (degraded) | Warning | Agent loop in degraded state |
| `cursor_lag_ledgers` | `> 50` | Warning | Event processing lagging |
| `dlq_size` | `> 20` | Warning | Dead Letter Queue growing |
| `events_processing_duration_seconds` (p95) | `> 2 seconds` | Warning | Event processing slow |
| `db_operation_duration_seconds` (p95) | `> 1 second` | Warning | Database operations slow |
| `http_request_duration_seconds` (p95) | `> 5 seconds` | Warning | HTTP requests slow |
| `agent_breaker_state{scope!="GLOBAL"}` | `== 2` for 2m | Warning | Protocol or user breaker OPEN — affected rebalancing halted |

### Info Alerts (Monitor Trend)

| Metric | Condition | Severity | Description |
|--------|-----------|----------|-------------|
| `dlq_size` | `> 5` | Info | DLQ has events (normal during issues) |
| `failure_rate` | `> 1%` | Info | Elevated failure rate |
| `events_processing_rate_per_minute` | `< 1` for 10m | Info | Low event processing rate |

## Prometheus Alert Rules Example

```yaml
groups:
  - name: neurowealth_critical
    interval: 30s
    rules:
      - alert: AgentLoopStopped
        expr: agent_loop_status == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Agent loop is not running"
          description: "Agent loop has been stopped for more than 1 minute"

      - alert: AgentLoopHeartbeatStale
        expr: time() - agent_loop_heartbeat_timestamp > 300
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Agent loop heartbeat is stale"
          description: "Agent loop heartbeat not updated for 5 minutes"

      - alert: CursorLagCritical
        expr: cursor_lag_ledgers > 100
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Event cursor lag critical"
          description: "Cursor lag is {{ $value }} ledgers (> 100)"

      - alert: DLQSizeCritical
        expr: dlq_size > 50
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Dead Letter Queue critically large"
          description: "DLQ has {{ $value }} events (> 50)"

      - alert: HighFailureRate
        expr: rate(failures_total[5m]) > 10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High failure rate detected"
          description: "Failure rate is {{ $value }} per minute (> 10)"

  - name: neurowealth_warning
    interval: 30s
    rules:
      - alert: AgentLoopDegraded
        expr: agent_loop_status == 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Agent loop in degraded state"
          description: "Agent loop has been degraded for more than 5 minutes"

      - alert: CursorLagWarning
        expr: cursor_lag_ledgers > 50
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Event cursor lag elevated"
          description: "Cursor lag is {{ $value }} ledgers (> 50)"

      - alert: DLQSizeWarning
        expr: dlq_size > 20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Dead Letter Queue growing"
          description: "DLQ has {{ $value }} events (> 20)"

      - alert: EventProcessingSlow
        expr: histogram_quantile(0.95, events_processing_duration_seconds) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Event processing slow"
          description: "P95 event processing duration is {{ $value }}s (> 2s)"

      - alert: DatabaseOperationsSlow
        expr: histogram_quantile(0.95, db_operation_duration_seconds) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Database operations slow"
          description: "P95 DB operation duration is {{ $value }}s (> 1s)"

      - alert: HTTPRequestsSlow
        expr: histogram_quantile(0.95, http_request_duration_seconds) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "HTTP requests slow"
          description: "P95 HTTP request duration is {{ $value }}s (> 5s)"
```

## Grafana Dashboard Recommendations

### Dashboard: NeuroWealth System Overview

**Row 1: System Health**
- Agent Loop Status (stat panel)
- Agent Loop Heartbeat (gauge panel, time since last heartbeat)
- Cursor Lag (graph panel)
- DLQ Size (stat panel with threshold colors)

**Row 2: Event Processing**
- Events Processed Total (graph panel, rate)
- Events Processing Rate (graph panel)
- Event Processing Duration (heatmap panel, by event type)
- Event Processing P95 Duration (graph panel)

**Row 3: Failures & DLQ**
- Failures Total (graph panel, rate)
- Failure Rate (graph panel)
- DLQ Size Over Time (graph panel)
- DLQ Retry Attempts (graph panel)

**Row 4: Database Performance**
- DB Operation Duration (heatmap panel, by operation type)
- DB Operation P95 Duration (graph panel)
- Active DB Connections (stat panel)

**Row 5: HTTP Performance**
- HTTP Request Rate (graph panel)
- HTTP Request Duration (heatmap panel, by route)
- HTTP Request P95 Duration (graph panel)
- HTTP Error Rate (graph panel)

**Row 6: Analytics API**
- Analytics Request Rate (graph panel)
- Analytics Request Duration (heatmap panel, by endpoint)
- Analytics Error Rate (graph panel)

### Dashboard: Agent Loop Details

**Row 1: Agent Status**
- Agent Loop Status (stat panel)
- Last Heartbeat (stat panel)
- Time Since Last Rebalance (stat panel)

**Row 2: Rebalance Operations**
- Rebalance Checks Total (graph panel, rate)
- Rebalance Checks Success Rate (stat panel)
- Rebalances Triggered Total (graph panel, rate)
- Rebalance Check Duration (graph panel)

**Row 3: Snapshot Operations**
- Snapshot Duration (graph panel)
- Snapshot P95 Duration (graph panel)

### Dashboard: Event Processing Details

**Row 1: Event Throughput**
- Events Processed by Type (graph panel, stacked)
- Events Processing Rate (graph panel)

**Row 2: Event Latency**
- Event Processing Duration by Type (heatmap panel)
- Event Processing P95 Duration by Type (graph panel)

**Row 3: Event Errors**
- Events Failed by Type (graph panel, stacked)
- Event Failure Rate by Type (graph panel)

## Grafana Panel Queries

### Agent Loop Status
```
agent_loop_status
```
Transform: Value mapping to text (0=Stopped, 1=Running, 2=Degraded)

### Agent Loop Heartbeat
```
time() - agent_loop_heartbeat_timestamp
```
Unit: seconds

### Cursor Lag
```
cursor_lag_ledgers
```

### DLQ Size
```
dlq_size
```
Thresholds: 0-5 (green), 5-20 (yellow), 20-50 (orange), 50+ (red)

### Events Processing Rate
```
rate(events_processed_total[5m])
```

### Event Processing P95 Duration
```
histogram_quantile(0.95, rate(events_processing_duration_seconds_bucket[5m]))
```

### Failure Rate
```
rate(failures_total[5m])
```

### DB Operation P95 Duration
```
histogram_quantile(0.95, rate(db_operation_duration_seconds_bucket[5m]))
```

### HTTP Request P95 Duration
```
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
```

## Deployment Recommendations

### Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'neurowealth-backend'
    metrics_path: '/metrics'
    scrape_interval: 30s
    static_configs:
      - targets: ['neurowealth-backend:3001']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
        replacement: 'neurowealth-production'
```

### Environment Variables

```bash
# Logging Configuration
LOG_LEVEL=info                    # debug, info, warn, error
NODE_ENV=production               # Enables JSON logging

# Metrics Configuration
# Metrics are automatically exposed at /metrics
# No additional configuration needed
```

### Cloud Logging Adapters

For production deployments, consider adding cloud logging adapters:

#### AWS CloudWatch
```typescript
import { CloudWatchTransport } from 'winston-cloudwatch'
import { addCloudLoggingAdapter } from './utils/logger'

const cloudWatchTransport = new CloudWatchTransport({
  logGroupName: '/neurowealth/backend',
  logStreamName: process.env.EC2_INSTANCE_ID || 'local',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  messageFormatter: ({ level, message, meta }) => {
    return `${level}: ${message} ${JSON.stringify(meta)}`
  }
})

addCloudLoggingAdapter(cloudWatchTransport)
```

#### Google Cloud Logging
```typescript
import { LoggingWinston } from '@google-cloud/logging-winston'
import { addCloudLoggingAdapter } from './utils/logger'

const gcloudLogging = new LoggingWinston({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  logName: 'neurowealth-backend'
})

addCloudLoggingAdapter(gcloudLogging)
```

#### Datadog
```typescript
import { DatadogTransport } from 'winston-datadog-logs-transport'
import { addCloudLoggingAdapter } from './utils/logger'

const datadogTransport = new DatadogTransport({
  apiKey: process.env.DATADOG_API_KEY,
  hostname: process.env.HOSTNAME,
  service: 'neurowealth-backend',
  ddsource: 'nodejs'
})

addCloudLoggingAdapter(datadogTransport)
```

### Log Rotation Configuration

The logger is configured with automatic log rotation:
- **Max file size**: 10MB per log file
- **Max files**: 5 files per log type (error.log, combined.log)
- **Total storage**: ~100MB per log type

Adjust these values in `src/utils/logger.ts` if needed.

### Sensitive Data Redaction

The logger automatically redacts sensitive data including:
- Passwords
- Secret keys
- API keys
- Authorization headers
- Bearer tokens
- 64-character hex strings (encryption keys)

Review and extend `SENSITIVE_PATTERNS` in `src/utils/logger.ts` for additional patterns.

## Monitoring Best Practices

1. **Set up alerts before deploying** - Ensure critical alerts are configured and tested
2. **Monitor the metrics** - Regularly review dashboard for anomalies
3. **Tune thresholds** - Adjust alert thresholds based on production behavior
4. **Investigate warnings** - Don't ignore warning alerts - they often precede critical issues
5. **Review DLQ regularly** - Even small DLQ sizes can indicate underlying issues
6. **Track trends** - Use Grafana dashboards to identify long-term trends and capacity planning
7. **Test alerting** - Periodically test alerting pipeline to ensure notifications work
8. **Document incidents** - Use alert history to improve thresholds and detection

## Troubleshooting

### High Cursor Lag
- Check Stellar RPC server connectivity
- Verify network congestion
- Review event processing logs for errors
- Check database performance

### Growing DLQ
- Review DLQ events for common error patterns
- Check if events are malformed or missing data
- Verify contract event schema matches expectations
- Consider increasing retry logic or fixing root cause

### Agent Loop Degraded/Stopped
- Check agent loop logs for errors
- Verify database connectivity
- Check for uncaught exceptions
- Review graceful shutdown logs

### Slow Database Operations
- Check database connection pool size
- Review slow query logs
- Verify database indexing
- Consider read replicas for analytics queries

### High HTTP Latency
- Check external API dependencies (Stellar RPC, Anthropic AI)
- Review rate limiting configuration
- Check network latency
- Consider caching for frequently accessed data
