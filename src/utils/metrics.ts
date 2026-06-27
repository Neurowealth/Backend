/**
 * Prometheus metrics registry for production-grade observability
 *
 * Provides counters and histograms for:
 * - Processed events
 * - Failures
 * - Latency
 * - DLQ size
 * - Cursor lag
 * - Agent loop heartbeat state
 */

import client from 'prom-client'

// Create a Registry to register the metrics
const register = new client.Registry()

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register })

// ── Global default label: env ────────────────────────────────────────────────
// Every metric emitted through this registry will carry `env` automatically,
// satisfying the acceptance criterion without modifying every Counter/Histogram.
register.setDefaultLabels({
  env: process.env.NODE_ENV || 'development',
})

// ── Event Processing Metrics ─────────────────────────────────────────────────────

export const eventsProcessedTotal = new client.Counter({
  name: 'events_processed_total',
  help: 'Total number of Stellar events processed',
  labelNames: ['event_type', 'status'] as const,
  registers: [register],
})

export const eventsProcessingDuration = new client.Histogram({
  name: 'events_processing_duration_seconds',
  help: 'Duration of event processing in seconds',
  labelNames: ['event_type'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
})

export const eventsProcessingRate = new client.Gauge({
  name: 'events_processing_rate_per_minute',
  help: 'Current event processing rate (events per minute)',
  registers: [register],
})

// ── Failure Metrics ─────────────────────────────────────────────────────────────

export const failuresTotal = new client.Counter({
  name: 'failures_total',
  help: 'Total number of failures across all systems',
  labelNames: ['component', 'error_type'] as const,
  registers: [register],
})

export const failureRate = new client.Gauge({
  name: 'failure_rate',
  help: 'Current failure rate (failures / total operations)',
  registers: [register],
})

// ── Dead Letter Queue Metrics ────────────────────────────────────────────────────

export const dlqSize = new client.Gauge({
  name: 'dlq_size',
  help: 'Current size of the Dead Letter Queue',
  registers: [register],
})

export const dlqRetryTotal = new client.Counter({
  name: 'dlq_retry_total',
  help: 'Total number of DLQ retry attempts',
  labelNames: ['status'] as const,
  registers: [register],
})

export const dlqAlertActive = new client.Gauge({
  name: 'dlq_alert_active',
  help: 'Whether a DLQ size alert is currently active (1=active, 0=inactive)',
  registers: [register],
})

// ── Cursor/Lag Metrics ──────────────────────────────────────────────────────────

export const cursorLag = new client.Gauge({
  name: 'cursor_lag_ledgers',
  help: 'Current cursor lag in ledgers (latest ledger - last processed ledger)',
  registers: [register],
})

export const lastProcessedLedger = new client.Gauge({
  name: 'last_processed_ledger',
  help: 'The last processed ledger number',
  registers: [register],
})

// ── Agent Loop Metrics ──────────────────────────────────────────────────────────

export const agentLoopHeartbeat = new client.Gauge({
  name: 'agent_loop_heartbeat_timestamp',
  help: 'Unix timestamp of the last agent loop heartbeat',
  registers: [register],
})

export const agentLoopStatus = new client.Gauge({
  name: 'agent_loop_status',
  help: 'Current agent loop status (0=stopped, 1=running, 2=degraded)',
  registers: [register],
})

export const agentRebalanceChecksTotal = new client.Counter({
  name: 'agent_rebalance_checks_total',
  help: 'Total number of rebalance checks performed',
  labelNames: ['status'] as const,
  registers: [register],
})

export const agentRebalancesTriggeredTotal = new client.Counter({
  name: 'agent_rebalances_triggered_total',
  help: 'Total number of rebalances triggered',
  registers: [register],
})

export const agentSnapshotDuration = new client.Histogram({
  name: 'agent_snapshot_duration_seconds',
  help: 'Duration of balance snapshot operations in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
})

// ── Database Operation Metrics ──────────────────────────────────────────────────

export const dbOperationDuration = new client.Histogram({
  name: 'db_operation_duration_seconds',
  help: 'Duration of database operations in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
})

export const dbConnectionsActive = new client.Gauge({
  name: 'db_connections_active',
  help: 'Number of active database connections',
  registers: [register],
})

// ── HTTP Request Metrics ─────────────────────────────────────────────────────────

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
})

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
})

// ── Analytics API Metrics ────────────────────────────────────────────────────────

export const analyticsRequestsTotal = new client.Counter({
  name: 'analytics_requests_total',
  help: 'Total number of analytics API requests',
  labelNames: ['endpoint', 'status'] as const,
  registers: [register],
})

export const analyticsRequestDuration = new client.Histogram({
  name: 'analytics_request_duration_seconds',
  help: 'Duration of analytics API requests in seconds',
  labelNames: ['endpoint'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
})

// ── Request Validation Metrics ────────────────────────────────────────────────────

export const rejectedRequestsTotal = new client.Counter({
  name: 'rejected_requests_total',
  help: 'Total number of rejected requests due to size or content-type',
  labelNames: ['reason'] as const,
  registers: [register],
})

// ── Background Job Metrics ──────────────────────────────────────────────────

export const backgroundJobsTotal = new client.Counter({
  name: 'background_jobs_total',
  help: 'Total number of background job executions',
  labelNames: ['job', 'status'] as const,
  registers: [register],
})

export const backgroundJobDuration = new client.Histogram({
  name: 'background_job_duration_seconds',
  help: 'Duration of background job executions in seconds',
  labelNames: ['job'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
})

// ── Data Retention Metrics ───────────────────────────────────────────────────

export const retentionDeletesTotal = new client.Counter({
  name: 'retention_deletes_total',
  help: 'Total number of rows deleted by retention cleanup jobs',
  labelNames: ['table'] as const,
  registers: [register],
})

export const retentionLastRunTimestamp = new client.Gauge({
  name: 'retention_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last successful retention job run per table',
  labelNames: ['table'] as const,
  registers: [register],
})

// ── External Service Error Metrics ──────────────────────────────────────────

export const externalServiceErrorsTotal = new client.Counter({
  name: 'external_service_errors_total',
  help: 'Total number of external service errors',
  labelNames: ['service', 'error_type'] as const,
  registers: [register],
})

// ── Rate Limit & Auth Metrics ────────────────────────────────────────────────

export const rateLimitHitsTotal = new client.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits by route group',
  labelNames: ['route_group', 'limiter_type'] as const,
  registers: [register],
})

export const authFailuresTotal = new client.Counter({
  name: 'auth_failures_total',
  help: 'Total number of authentication failures',
  labelNames: ['endpoint', 'failure_type'] as const,
  registers: [register],
})

export const rateLimitActiveViolations = new client.Gauge({
  name: 'rate_limit_active_violations',
  help: 'Current number of active rate limit violations by route group',
  labelNames: ['route_group'] as const,
  registers: [register],
})

// ── Helper Functions ─────────────────────────────────────────────────────────────

/**
 * Record a successful event processing
 */
export function recordEventProcessed(eventType: string): void {
  eventsProcessedTotal.inc({ event_type: eventType, status: 'success' })
}

/**
 * Record a failed event processing
 */
export function recordEventFailed(eventType: string, errorType: string): void {
  eventsProcessedTotal.inc({ event_type: eventType, status: 'failed' })
  failuresTotal.inc({ component: 'event_listener', error_type: errorType })
}

/**
 * Record event processing duration
 */
export function recordEventDuration(eventType: string, durationSeconds: number): void {
  eventsProcessingDuration.observe({ event_type: eventType }, durationSeconds)
}

/**
 * Update DLQ size
 */
export function updateDlqSize(size: number): void {
  dlqSize.set(size)
}

/**
 * Update cursor lag
 */
export function updateCursorLag(lag: number): void {
  cursorLag.set(lag)
}

/**
 * Update last processed ledger
 */
export function updateLastProcessedLedger(ledger: number): void {
  lastProcessedLedger.set(ledger)
}

/**
 * Update agent loop heartbeat
 */
export function updateAgentHeartbeat(): void {
  agentLoopHeartbeat.set(Date.now() / 1000)
}

/**
 * Update agent loop status
 */
export function updateAgentStatus(status: 'stopped' | 'running' | 'degraded'): void {
  const statusValue = status === 'stopped' ? 0 : status === 'running' ? 1 : 2
  agentLoopStatus.set(statusValue)
}

/**
 * Record a rebalance check
 */
export function recordRebalanceCheck(status: 'success' | 'failed'): void {
  agentRebalanceChecksTotal.inc({ status })
}

/**
 * Record a rebalance triggered
 */
export function recordRebalanceTriggered(): void {
  agentRebalancesTriggeredTotal.inc()
}

/**
 * Record database operation duration
 */
export function recordDbOperation(operation: string, durationSeconds: number): void {
  dbOperationDuration.observe({ operation }, durationSeconds)
}

/**
 * Record HTTP request
 */
export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number
): void {
  httpRequestsTotal.inc({ method, route, status_code: statusCode.toString() })
  httpRequestDuration.observe(
    { method, route, status_code: statusCode.toString() },
    durationSeconds
  )
}

/**
 * Record analytics API request
 */
export function recordAnalyticsRequest(
  endpoint: string,
  status: 'success' | 'failed',
  durationSeconds: number
): void {
  analyticsRequestsTotal.inc({ endpoint, status })
  analyticsRequestDuration.observe({ endpoint }, durationSeconds)
}

/**
 * Record a background job execution
 */
export function recordBackgroundJob(
  job: string,
  status: 'success' | 'failed',
  durationSeconds: number
): void {
  backgroundJobsTotal.inc({ job, status })
  backgroundJobDuration.observe({ job }, durationSeconds)
}

/**
 * Record rows deleted by a retention job
 */
export function recordRetentionDeletes(table: string, count: number): void {
  retentionDeletesTotal.inc({ table }, count)
  retentionLastRunTimestamp.set({ table }, Date.now() / 1000)
}

/**
 * Record an external service error
 */
export function recordExternalServiceError(
  service: string,
  errorType: string
): void {
  externalServiceErrorsTotal.inc({ service, error_type: errorType })
}

/**
 * Record a rate limit hit
 */
export function recordRateLimitHit(routeGroup: string, limiterType: string): void {
  rateLimitHitsTotal.inc({ route_group: routeGroup, limiter_type: limiterType })
}

/**
 * Record an authentication failure
 */
export function recordAuthFailure(endpoint: string, failureType: string): void {
  authFailuresTotal.inc({ endpoint, failure_type: failureType })
}

/**
 * Update active rate limit violations
 */
export function updateRateLimitViolations(routeGroup: string, count: number): void {
  rateLimitActiveViolations.set({ route_group: routeGroup }, count)
}

/**
 * Record a rejected request due to size or content-type
 */
export function recordRejectedRequest(reason: 'oversized' | 'content_type'): void {
  rejectedRequestsTotal.inc({ reason })
}

/**
 * Get metrics for Prometheus scraping
 */
export async function getMetrics(): Promise<string> {
  return await register.metrics()
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  register.resetMetrics()
}

export { register }
