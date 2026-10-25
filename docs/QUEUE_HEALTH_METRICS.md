# Queue Health Metrics

## Overview

This document describes the real-time metrics for queue lag, worker saturation, and throughput. These metrics enable detection of bottlenecks before they cause outages or delayed processing.

## Metrics

### Queue Lag

**Metric:** `queue_lag_seconds`

**Description:** Time in seconds that the oldest item has been waiting in the queue.

**Labels:**
- `queue_name`: Name of the queue (e.g., `outbox`, `dead_letter`, `events`)

**Thresholds:**
- **Warning:** > 60 seconds
- **Critical:** > 300 seconds (5 minutes)

**Alert Rule:**
```yaml
- alert: QueueLagHigh
  expr: queue_lag_seconds > 300
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Queue {{ $labels.queue_name }} lag is critical"
    description: "Items have been waiting for {{ $value }} seconds"
```

### Queue Depth

**Metric:** `queue_depth`

**Description:** Current number of items in the queue.

**Labels:**
- `queue_name`: Name of the queue

**Thresholds:**
- **Warning:** > 1000 items
- **Critical:** > 5000 items

**Alert Rule:**
```yaml
- alert: QueueDepthHigh
  expr: queue_depth > 5000
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Queue {{ $labels.queue_name }} depth is critical"
    description: "{{ $value }} items are queued"
```

### Queue Throughput

**Metric:** `queue_throughput_per_second`

**Description:** Items processed per second (rolling 1-minute average).

**Labels:**
- `queue_name`: Name of the queue

**Thresholds:**
- **Warning:** < 1 item/second for high-volume queues
- **Critical:** < 0.1 items/second for any queue

**Alert Rule:**
```yaml
- alert: QueueThroughputLow
  expr: queue_throughput_per_second < 0.1
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Queue {{ $labels.queue_name }} throughput is low"
    description: "Processing {{ $value }} items per second"
```

### Worker Saturation

**Metric:** `worker_saturation`

**Description:** Worker utilization as a percentage (0-100).

**Labels:**
- `worker_type`: Type of worker (e.g., `outbox_dispatcher`, `event_processor`, `agent_loop`)

**Thresholds:**
- **Healthy:** < 70%
- **Warning:** 70-90%
- **Critical:** > 90%

**Alert Rule:**
```yaml
- alert: WorkerSaturationHigh
  expr: worker_saturation > 90
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Worker {{ $labels.worker_type }} saturation is high"
    description: "Workers are {{ $value }}% utilized"
```

### Worker Active Count

**Metric:** `worker_active_count`

**Description:** Number of currently active workers.

**Labels:**
- `worker_type`: Type of worker

**Thresholds:**
- **Warning:** All workers active (no idle capacity)
- **Critical:** All workers active for > 10 minutes

### Worker Idle Count

**Metric:** `worker_idle_count`

**Description:** Number of currently idle workers.

**Labels:**
- `worker_type`: Type of worker

**Thresholds:**
- **Warning:** All workers idle (possible worker pool issue)
- **Healthy:** At least 1 idle worker

### Worker Processing Duration

**Metric:** `worker_processing_duration_seconds`

**Description:** Duration of worker task processing in seconds.

**Labels:**
- `worker_type`: Type of worker
- `queue_name`: Queue being processed

**Buckets:** [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60]

**Thresholds:**
- **Warning:** p95 > 30 seconds
- **Critical:** p95 > 60 seconds

**Alert Rule:**
```yaml
- alert: WorkerProcessingSlow
  expr: histogram_quantile(0.95, worker_processing_duration_seconds) > 60
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Worker {{ $labels.worker_type }} processing is slow"
    description: "p95 latency is {{ $value }} seconds"
```

### Queue Processing Errors

**Metric:** `queue_processing_errors_total`

**Description:** Total number of queue processing errors.

**Labels:**
- `queue_name`: Name of the queue
- `error_type`: Type of error (e.g., `timeout`, `validation`, `database`)

**Thresholds:**
- **Warning:** > 10 errors in 5 minutes
- **Critical:** > 50 errors in 5 minutes

**Alert Rule:**
```yaml
- alert: QueueProcessingErrorsHigh
  expr: rate(queue_processing_errors_total[5m]) > 10
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Queue {{ $labels.queue_name }} has high error rate"
    description: "{{ $value }} errors per second"
```

### Queue Blocked Time

**Metric:** `queue_blocked_seconds`

**Description:** Time in seconds the queue has been blocked (unable to process).

**Labels:**
- `queue_name`: Name of the queue

**Thresholds:**
- **Warning:** > 60 seconds
- **Critical:** > 300 seconds

**Alert Rule:**
```yaml
- alert: QueueBlocked
  expr: queue_blocked_seconds > 300
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Queue {{ $labels.queue_name }} is blocked"
    description: "Blocked for {{ $value }} seconds"
```

## Worker Saturation Thresholds

### Outbox Dispatcher
- **Max Workers:** 10
- **Saturation Warning:** 70%
- **Saturation Critical:** 90%
- **Target Throughput:** 100 ops/minute

### Event Processor
- **Max Workers:** 5
- **Saturation Warning:** 70%
- **Saturation Critical:** 90%
- **Target Throughput:** 500 events/minute

### Agent Loop
- **Max Workers:** 1 (single-threaded)
- **Saturation Warning:** 80%
- **Saturation Critical:** 95%
- **Target Throughput:** 1 rebalance check/minute

### Background Jobs
- **Max Workers:** 3
- **Saturation Warning:** 70%
- **Saturation Critical:** 90%
- **Target Throughput:** 10 jobs/minute

## Implementation

### Recording Metrics

```typescript
import {
  recordQueueLag,
  recordQueueDepth,
  recordQueueThroughput,
  recordWorkerSaturation,
  recordWorkerActiveCount,
  recordWorkerIdleCount,
  recordWorkerProcessingDuration,
  recordQueueProcessingError,
  recordQueueBlocked,
} from '../utils/metrics'

// Record queue lag
recordQueueLag('outbox', 45.5)

// Record queue depth
recordQueueDepth('outbox', 1250)

// Record throughput
recordQueueThroughput('outbox', 2.5)

// Record worker saturation
recordWorkerSaturation('outbox_dispatcher', 75)

// Record worker counts
recordWorkerActiveCount('outbox_dispatcher', 8)
recordWorkerIdleCount('outbox_dispatcher', 2)

// Record processing duration
const startTime = Date.now()
await processItem()
const duration = (Date.now() - startTime) / 1000
recordWorkerProcessingDuration('outbox_dispatcher', 'outbox', duration)

// Record error
recordQueueProcessingError('outbox', 'timeout')

// Record blocked time
recordQueueBlocked('outbox', 120)
```

### Monitoring Job

Create a background job to collect and report metrics:

```typescript
// src/jobs/queueMetrics.ts
import db from '../db'
import {
  recordQueueLag,
  recordQueueDepth,
  recordQueueThroughput,
  recordWorkerSaturation,
  recordWorkerActiveCount,
  recordWorkerIdleCount,
} from '../utils/metrics'

export async function collectQueueMetrics(): Promise<void> {
  // Outbox queue metrics
  const outboxStats = await db.outboxOp.groupBy({
    by: ['status'],
    _count: true,
  })

  const totalOutbox = outboxStats.reduce((sum, stat) => sum + stat._count, 0)
  const submittedOutbox = outboxStats.find(s => s.status === 'SUBMITTED')?._count || 0

  recordQueueDepth('outbox', totalOutbox)

  // Calculate lag (average age of SUBMITTED items)
  if (submittedOutbox > 0) {
    const oldestSubmitted = await db.outboxOp.findFirst({
      where: { status: 'SUBMITTED' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })

    if (oldestSubmitted) {
      const lag = (Date.now() - oldestSubmitted.createdAt.getTime()) / 1000
      recordQueueLag('outbox', lag)
    }
  }

  // Worker metrics (would be collected from worker pool)
  // recordWorkerSaturation('outbox_dispatcher', saturation)
  // recordWorkerActiveCount('outbox_dispatcher', activeCount)
  // recordWorkerIdleCount('outbox_dispatcher', idleCount)
}
```

## Alerting Strategy

### Sustained Bottleneck Detection

Alert on sustained high saturation or lag to avoid noise from temporary spikes:

```yaml
- alert: SustainedQueueBottleneck
  expr: |
    (queue_lag_seconds > 300 or worker_saturation > 90)
    and rate(queue_processing_errors_total[5m]) > 1
  for: 15m
  labels:
    severity: critical
  annotations:
    summary: "Sustained bottleneck detected in {{ $labels.queue_name }}"
    description: "Queue has been degraded for 15 minutes"
```

### Multi-Queue Correlation

Alert when multiple queues are degraded simultaneously:

```yaml
- alert: MultiQueueDegradation
  expr: count(queue_lag_seconds > 300) > 2
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Multiple queues are degraded"
    description: "{{ $value }} queues have critical lag"
```

## Dashboard Queries

### Queue Health Overview

```promql
# Queue lag by queue
queue_lag_seconds

# Queue depth by queue
queue_depth

# Throughput by queue
rate(queue_throughput_per_second[5m])

# Worker saturation by type
worker_saturation
```

### Worker Pool Health

```promql
# Active vs idle workers
worker_active_count + worker_idle_count

# Worker utilization
worker_active_count / (worker_active_count + worker_idle_count) * 100

# Processing latency p95
histogram_quantile(0.95, worker_processing_duration_seconds)
```

### Error Rate

```promql
# Error rate by queue
rate(queue_processing_errors_total[5m])

# Error rate by type
sum(rate(queue_processing_errors_total[5m])) by (error_type)
```

## Configuration

Environment variables for queue monitoring:

```env
# Queue monitoring interval
QUEUE_METRICS_INTERVAL_MS=15000

# Alert thresholds
QUEUE_LAG_WARNING_SECONDS=60
QUEUE_LAG_CRITICAL_SECONDS=300
QUEUE_DEPTH_WARNING=1000
QUEUE_DEPTH_CRITICAL=5000
WORKER_SATURATION_WARNING=70
WORKER_SATURATION_CRITICAL=90
```

## Runbook

### High Queue Lag

**Symptoms:**
- `queue_lag_seconds` > 300
- `queue_depth` increasing
- `worker_saturation` > 90%

**Investigation:**
1. Check worker health: Are workers running?
2. Check database: Is the database slow?
3. Check external dependencies: Are external services responding?
4. Check for deadlocks: Are there any database deadlocks?

**Mitigation:**
1. Scale up workers if possible
2. Increase worker pool size
3. Throttle incoming requests
4. Restart stuck workers

### High Worker Saturation

**Symptoms:**
- `worker_saturation` > 90%
- `worker_active_count` at max
- `worker_idle_count` = 0

**Investigation:**
1. Check processing duration: Are tasks taking longer?
2. Check for stuck tasks: Are any tasks hanging?
3. Check resource limits: CPU, memory, database connections

**Mitigation:**
1. Increase worker pool size
2. Optimize slow tasks
3. Add timeout to stuck tasks
4. Scale horizontally

### Low Throughput

**Symptoms:**
- `queue_throughput_per_second` < 0.1
- `queue_depth` stable or increasing
- `worker_processing_duration` normal

**Investigation:**
1. Check worker count: Are workers running?
2. Check for blocking: Is the queue blocked?
3. Check for errors: Are tasks failing silently?

**Mitigation:**
1. Restart worker pool
2. Check for configuration errors
3. Review task logic for bugs

## Implementation References

- **Metrics:** `src/utils/metrics.ts`
- **Collection Job:** `src/jobs/queueMetrics.ts` (to be created)
- **Configuration:** `src/config/env.ts`
