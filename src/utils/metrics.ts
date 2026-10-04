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
 * - Queue lag, worker saturation, and throughput
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

export const outboundNotificationAttempts = new client.Counter({
  name: 'outbound_notification_attempts_total',
  help: 'Outbound notification delivery attempts by channel and outcome',
  labelNames: ['channel', 'status'] as const,
  registers: [register],
})

export const outboundNotificationDlqSize = new client.Gauge({
  name: 'outbound_notification_dlq_size',
  help: 'Current number of outbound notifications in the dead-letter queue',
  registers: [register],
})

export const secretCredentialValidationFailures = new client.Gauge({
  name: 'secret_credential_validation_failures',
  help: 'Number of missing, expired, or malformed configured secrets',
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

// #345 — agent circuit breaker observability.

export const agentBreakerState = new client.Gauge({
  name: 'agent_breaker_state',
  help: 'Agent circuit breaker state by scope and key: 0 closed, 1 half-open, 2 open',
  labelNames: ['scope', 'scopeKey'] as const,
  registers: [register],
})

export const agentBreakerTripsTotal = new client.Counter({
  name: 'agent_breaker_trips_total',
  help: 'Agent circuit breaker trips by scope and rule',
  labelNames: ['scope', 'rule'] as const,
  registers: [register],
})

/**
 * Record a breaker's current state for dashboards.
 */
export function setAgentBreakerState(
  scope: string,
  scopeKey: string,
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'
): void {
  const value = state === 'CLOSED' ? 0 : state === 'HALF_OPEN' ? 1 : 2
  agentBreakerState.set({ scope, scopeKey }, value)
}

/**
 * Record a breaker trip (or re-trip).
 */
export function recordAgentBreakerTrip(scope: string, rule: string): void {
  agentBreakerTripsTotal.inc({ scope, rule })
}

export const agentSnapshotDuration = new client.Histogram({
  name: 'agent_snapshot_duration_seconds',
  help: 'Duration of balance snapshot operations in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
})

export const portfolioAnnualisedVolatilityPct = new client.Histogram({
  name: 'portfolio_annualised_volatility_pct',
  help: 'Annualised portfolio volatility observed by the rebalance circuit breaker, in percent',
  buckets: [5, 10, 20, 30, 50, 75, 100, 150, 200],
  registers: [register],
})

export const volatilityBreakerTripsTotal = new client.Counter({
  name: 'portfolio_volatility_circuit_breaker_trips_total',
  help: 'Total number of portfolio volatility circuit-breaker activations',
  registers: [register],
})

export const volatilityBreakerActivePortfolios = new client.Gauge({
  name: 'portfolio_volatility_circuit_breaker_active_portfolios',
  help: 'Number of portfolios currently blocked by the volatility circuit breaker',
  registers: [register],
})

export const volatilityBreakerEvaluationFailuresTotal = new client.Counter({
  name: 'portfolio_volatility_circuit_breaker_evaluation_failures_total',
  help: 'Total number of portfolio risk evaluations that failed closed',
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

// ── Prisma Connection Pool Metrics ──────────────────────────────────────────────
// Sourced from prisma.$metrics.json() and refreshed by the poolMetrics job.

export const dbPoolSize = new client.Gauge({
  name: 'db_pool_size',
  help: 'Total connections in the Prisma connection pool (open connections)',
  registers: [register],
})

export const dbPoolActive = new client.Gauge({
  name: 'db_pool_active',
  help: 'Connections currently in use (busy)',
  registers: [register],
})

export const dbPoolIdle = new client.Gauge({
  name: 'db_pool_idle',
  help: 'Idle connections available in the pool',
  registers: [register],
})

export const dbPoolWaitCount = new client.Gauge({
  name: 'db_pool_wait_count',
  help: 'Number of queries currently waiting for a free connection',
  registers: [register],
})

export const dbPoolWaitDurationMs = new client.Gauge({
  name: 'db_pool_wait_duration_ms',
  help: 'Cumulative time (ms) queries have spent waiting for a connection',
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

// ── Request Timeout Metrics ───────────────────────────────────────────────────

export const requestTimeoutsTotal = new client.Counter({
  name: 'request_timeouts_total',
  help: 'Total number of HTTP requests that timed out before completing',
  labelNames: ['route_group'] as const,
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
  help: 'Total number of rate limit hits by route group, limiter tier and principal type',
  labelNames: ['route_group', 'limiter_type', 'principal_type'] as const,
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

// ── Fiat Provider Metrics (#313) ─────────────────────────────────────────────

export const fiatQuoteLatency = new client.Histogram({
  name: 'fiat_quote_latency_seconds',
  help: 'Latency of a single fiat provider quote request',
  labelNames: ['provider', 'direction'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
})

export const fiatQuoteFailuresTotal = new client.Counter({
  name: 'fiat_quote_failures_total',
  help: 'Total number of failed fiat provider quote requests',
  labelNames: ['provider', 'reason'] as const,
  registers: [register],
})

export const fiatOrdersTotal = new client.Counter({
  name: 'fiat_orders_total',
  help: 'Total number of fiat orders by provider and outcome',
  labelNames: ['provider', 'status'] as const,
  registers: [register],
})

export const fiatProviderCircuitState = new client.Gauge({
  name: 'fiat_provider_circuit_state',
  help: 'Current circuit breaker state per fiat provider (0=closed, 1=half-open, 2=open)',
  labelNames: ['provider'] as const,
  registers: [register],
})

export const fiatRateDriftPct = new client.Histogram({
  name: 'fiat_rate_drift_pct',
  help: 'Absolute percentage drift between quoted and settled crypto amount',
  labelNames: ['provider', 'direction'] as const,
  buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25],
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
export function recordEventDuration(
  eventType: string,
  durationSeconds: number
): void {
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
export function updateAgentStatus(
  status: 'stopped' | 'running' | 'degraded'
): void {
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

export function observePortfolioVolatility(volatilityPct: number): void {
  portfolioAnnualisedVolatilityPct.observe(volatilityPct)
}

export function recordVolatilityBreakerTrip(): void {
  volatilityBreakerTripsTotal.inc()
}

export function setVolatilityBreakerActivePortfolios(count: number): void {
  volatilityBreakerActivePortfolios.set(count)
}

export function recordVolatilityBreakerEvaluationFailure(): void {
  volatilityBreakerEvaluationFailuresTotal.inc()
}

/**
 * Record database operation duration
 */
export function recordDbOperation(
  operation: string,
  durationSeconds: number
): void {
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
 * Record a timed-out HTTP request
 */
export function recordRequestTimeout(routeGroup: string): void {
  requestTimeoutsTotal.inc({ route_group: routeGroup })
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
/**
 * Record a request blocked by a rate limiter (#473).
 *
 * `principalType` is what makes this alertable: a rise in `anonymous` blocks is
 * scraping or credential stuffing, while a rise in `authenticated` blocks is a
 * broken client or a leaked key. Same 429 status, completely different incident.
 */
export function recordRateLimitHit(
  routeGroup: string,
  limiterType: string,
  principalType: string = 'unknown'
): void {
  rateLimitHitsTotal.inc({
    route_group: routeGroup,
    limiter_type: limiterType,
    principal_type: principalType,
  })
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
export function updateRateLimitViolations(
  routeGroup: string,
  count: number
): void {
  rateLimitActiveViolations.set({ route_group: routeGroup }, count)
}

/**
 * Record a request rejected before it reached a route handler — oversized
 * payload, disallowed content type, or a CORS origin failure (#471).
 */
export function recordRejectedRequest(
  reason: 'oversized' | 'content_type' | 'cors_origin' | 'cors_misconfiguration'
): void {
  rejectedRequestsTotal.inc({ reason })
}

/**
 * Record a fiat provider quote attempt's latency (success or failure).
 */
export function recordFiatQuoteLatency(
  provider: string,
  direction: string,
  durationSeconds: number
): void {
  fiatQuoteLatency.observe({ provider, direction }, durationSeconds)
}

/**
 * Record a failed fiat provider quote request.
 */
export function recordFiatQuoteFailure(provider: string, reason: string): void {
  fiatQuoteFailuresTotal.inc({ provider, reason })
}

/**
 * Record a fiat order outcome for a provider.
 */
export function recordFiatOrder(provider: string, status: string): void {
  fiatOrdersTotal.inc({ provider, status })
}

/**
 * Reflect a fiat provider's circuit breaker state in a gauge for dashboards.
 */
export function setFiatProviderCircuitState(
  provider: string,
  state: 'closed' | 'half-open' | 'open'
): void {
  const value = state === 'closed' ? 0 : state === 'half-open' ? 1 : 2
  fiatProviderCircuitState.set({ provider }, value)
}

/**
 * Record the absolute percentage drift between a quoted and settled amount.
 */
export function recordFiatRateDrift(
  provider: string,
  direction: string,
  absDriftPct: number
): void {
  fiatRateDriftPct.observe({ provider, direction }, absDriftPct)
}

// ── Outbox Metrics (#325) ────────────────────────────────────────────────────

export const outboxOpsTotal = new client.Counter({
  name: 'outbox_ops_total',
  help: 'Total outbox op submit attempts, by kind/priority/outcome',
  labelNames: ['kind', 'priority', 'outcome'] as const, // outcome: confirmed|retry|failed
  registers: [register],
})

export const outboxQueueDepth = new client.Gauge({
  name: 'outbox_queue_depth',
  help: 'Current outbox op count by status and priority',
  labelNames: ['status', 'priority'] as const,
  registers: [register],
})

export const outboxOpLatencySeconds = new client.Histogram({
  name: 'outbox_op_latency_seconds',
  help: 'Time from outbox op creation to confirmation, in seconds',
  labelNames: ['kind'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
})

export const outboxFeeBumpTotal = new client.Counter({
  name: 'outbox_fee_bump_total',
  help: 'Total fee-bump resubmissions triggered by unconfirmed-too-long ops',
  labelNames: ['kind'] as const,
  registers: [register],
})

export const outboxStuckSubmitted = new client.Gauge({
  name: 'outbox_stuck_submitted',
  help: 'Ops SUBMITTED but unconfirmed longer than the configured timeout — the "lost in flight" alarm',
  registers: [register],
})

export function recordOutboxOp(
  kind: string,
  priority: string,
  outcome: 'confirmed' | 'retry' | 'failed'
): void {
  outboxOpsTotal.inc({ kind, priority, outcome })
}

export function updateOutboxQueueDepth(
  rows: Array<{ status: string; priority: string; count: number }>
): void {
  outboxQueueDepth.reset()
  for (const row of rows) {
    outboxQueueDepth.set(
      { status: row.status, priority: row.priority },
      row.count
    )
  }
}

export function recordOutboxLatency(kind: string, seconds: number): void {
  outboxOpLatencySeconds.observe({ kind }, seconds)
}

export function recordOutboxFeeBump(kind: string): void {
  outboxFeeBumpTotal.inc({ kind })
}

export function updateOutboxStuckSubmitted(count: number): void {
  outboxStuckSubmitted.set(count)
}

// ── Fee Oracle Metrics (#342) ────────────────────────────────────────────────

export const feeOracleRecommendedBaseFee = new client.Gauge({
  name: 'fee_oracle_recommended_base_fee',
  help: 'Recommended base fee in stroops (p70 of inclusion fees, floored at 100)',
  registers: [register],
})

export const feeOracleAggressiveBaseFee = new client.Gauge({
  name: 'fee_oracle_aggressive_base_fee',
  help: 'Aggressive base fee in stroops (p95) for CRITICAL ops during congestion',
  registers: [register],
})

export const feeOracleLedgerCapacityUsage = new client.Gauge({
  name: 'fee_oracle_ledger_capacity_usage',
  help: 'Ledger capacity usage 0..1 from latest ledger',
  registers: [register],
})

export const feeOracleCongestionLevel = new client.Gauge({
  name: 'fee_oracle_congestion_level',
  help: 'Congestion level as numeric enum (0=low,1=elevated,2=high,3=severe)',
  registers: [register],
})

export const feeOracleStalenessSeconds = new client.Gauge({
  name: 'fee_oracle_staleness_seconds',
  help: 'Seconds since last successful fee oracle sample',
  registers: [register],
})

export const feeOracleClampTotal = new client.Counter({
  name: 'fee_oracle_clamp_total',
  help: 'Fee oracle clamps to min/max bounds',
  labelNames: ['bound'] as const,
  registers: [register],
})

export const outboxLowDeferredTotal = new client.Counter({
  name: 'outbox_low_deferred_total',
  help: 'LOW ops deferred due to high congestion',
  registers: [register],
})

export const outboxAggressiveFeeUsedTotal = new client.Counter({
  name: 'outbox_aggressive_fee_used_total',
  help: 'CRITICAL ops that used aggressive base fee during congestion',
  registers: [register],
})

export const outboxMaxFeeHitTotal = new client.Counter({
  name: 'outbox_max_fee_hit_total',
  help: 'Ops that hit OUTBOX_MAX_ABS_FEE cap',
  labelNames: ['priority'] as const,
  registers: [register],
})

export function recordFeeOracleClamp(bound: 'min' | 'max'): void {
  feeOracleClampTotal.inc({ bound })
}

export function recordOutboxLowDeferred(): void {
  outboxLowDeferredTotal.inc()
}

export function recordOutboxAggressiveFeeUsed(): void {
  outboxAggressiveFeeUsedTotal.inc()
}

export function recordOutboxMaxFeeHit(priority: string): void {
  outboxMaxFeeHitTotal.inc({ priority })
}

// ── Sponsored Reserves Metrics (#339) ──────────────────────────────────────

export const reserveOutstandingXlm = new client.Gauge({
  name: 'reserve_sponsorship_outstanding_xlm',
  help: 'Sum of xlmReserved for ACTIVE ReserveSponsorship rows — platform outstanding reserve liability',
  registers: [register],
})

export const sponsorAvailableXlmGauge = new client.Gauge({
  name: 'sponsor_available_xlm',
  help: 'Available XLM per sponsor account (balance - selling liabilities)',
  labelNames: ['sponsorAccount'] as const,
  registers: [register],
})

export const reserveReconciliationDrift = new client.Gauge({
  name: 'reserve_reconciliation_drift_xlm',
  help: 'Drift between recorded xlmReserved and on-chain base reserve',
  registers: [register],
})

export const sponsorCapacityExhaustedTotal = new client.Counter({
  name: 'sponsor_capacity_exhausted_total',
  help: 'Times provisioning refused due to sponsor_capacity_exhausted',
  registers: [register],
})

// ── Real-time WebSocket streaming metrics (#316) ─────────────────────────────

export const wsConnectionsActive = new client.Gauge({
  name: 'ws_connections_active',
  help: 'Currently open authenticated WebSocket connections',
  labelNames: ['mode'] as const, // mode: self|delegated
  registers: [register],
})

export const wsHandshakesTotal = new client.Counter({
  name: 'ws_handshakes_total',
  help: 'WebSocket handshake attempts by outcome',
  labelNames: ['outcome'] as const, // outcome: accepted|unauthorized|forbidden|rate_limited|too_many
  registers: [register],
})

export const wsMessagesSentTotal = new client.Counter({
  name: 'ws_messages_sent_total',
  help: 'Frames pushed to clients, by topic and delivery path',
  labelNames: ['topic', 'path'] as const, // path: live|replay
  registers: [register],
})

export const wsMessagesReceivedTotal = new client.Counter({
  name: 'ws_messages_received_total',
  help: 'Client messages received, by message type',
  labelNames: ['type'] as const,
  registers: [register],
})

export const wsReplayEventsTotal = new client.Counter({
  name: 'ws_replay_events_total',
  help: 'Events replayed from the durable stream on resume',
  registers: [register],
})

export const wsGapsTotal = new client.Counter({
  name: 'ws_gaps_total',
  help: 'Gap frames emitted, by reason (retention|backpressure|unknown_stream)',
  labelNames: ['reason'] as const,
  registers: [register],
})

export const wsDroppedEventsTotal = new client.Counter({
  name: 'ws_dropped_events_total',
  help: 'Events dropped rather than delivered, by reason (backpressure|coalesced)',
  labelNames: ['reason'] as const,
  registers: [register],
})

export const wsBridgePublishTotal = new client.Counter({
  name: 'ws_bridge_publish_total',
  help: 'Cross-pod event publishes, by transport outcome',
  labelNames: ['outcome'] as const, // outcome: redis|local_only|error
  registers: [register],
})

export const wsPublishFailuresTotal = new client.Counter({
  name: 'ws_publish_failures_total',
  help: 'publishUserEvent calls that failed to persist to the durable stream',
  registers: [register],
})

export function setWsConnectionsActive(
  mode: 'self' | 'delegated',
  count: number
): void {
  wsConnectionsActive.set({ mode }, count)
}

export function recordWsHandshake(
  outcome:
    'accepted' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'too_many'
): void {
  wsHandshakesTotal.inc({ outcome })
}

export function recordWsMessageSent(
  topic: string,
  path: 'live' | 'replay'
): void {
  wsMessagesSentTotal.inc({ topic, path })
}

export function recordWsMessageReceived(type: string): void {
  wsMessagesReceivedTotal.inc({ type })
}

export function recordWsReplay(count: number): void {
  if (count > 0) wsReplayEventsTotal.inc(count)
}

export function recordWsGap(reason: string): void {
  wsGapsTotal.inc({ reason })
}

export function recordWsDroppedEvents(
  reason: 'backpressure' | 'coalesced',
  count = 1
): void {
  wsDroppedEventsTotal.inc({ reason }, count)
}

export function recordWsBridgePublish(
  outcome: 'redis' | 'local_only' | 'error'
): void {
  wsBridgePublishTotal.inc({ outcome })
}

export function recordWsPublishFailure(): void {
  wsPublishFailuresTotal.inc()
}

// ── Tool-calling assistant metrics (#318) ────────────────────────────────────

export const assistantTokensTotal = new client.Counter({
  name: 'assistant_tokens_total',
  help: 'Total tokens spent by the tool-calling assistant planner',
  registers: [register],
})

export const assistantToolCallDuration = new client.Histogram({
  name: 'assistant_tool_call_duration_seconds',
  help: 'Duration of an assistant tool execution in seconds',
  labelNames: ['tool', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
})

export const assistantToolCallsTotal = new client.Counter({
  name: 'assistant_tool_calls_total',
  help: 'Total assistant tool calls, by tool and outcome',
  labelNames: ['tool', 'outcome'] as const,
  registers: [register],
})

export const assistantFallbackTotal = new client.Counter({
  name: 'assistant_fallback_total',
  help: 'Total times the assistant degraded to the rule-based parser',
  labelNames: ['reason'] as const,
  registers: [register],
})

export function recordAssistantTokenSpend(tokens: number): void {
  assistantTokensTotal.inc(tokens)
}

export function recordAssistantToolCall(
  tool: string,
  outcome: 'executed' | 'rejected' | 'error',
  durationSeconds?: number
): void {
  assistantToolCallsTotal.inc({ tool, outcome })
  if (durationSeconds !== undefined) {
    assistantToolCallDuration.observe(
      { tool, status: outcome },
      durationSeconds
    )
  }
}

export function recordAssistantFallback(
  reason: 'model_error' | 'budget_exceeded' | 'schema_error'
): void {
  assistantFallbackTotal.inc({ reason })
}

// ── Queue Health Metrics (#520) ─────────────────────────────────────────────

export const queueLagSeconds = new client.Gauge({
  name: 'queue_lag_seconds',
  help: 'Time in seconds that the oldest item has been waiting in the queue',
  labelNames: ['queue_name'] as const,
  registers: [register],
})

export const queueDepth = new client.Gauge({
  name: 'queue_depth',
  help: 'Current number of items in the queue',
  labelNames: ['queue_name'] as const,
  registers: [register],
})

export const queueThroughputPerSecond = new client.Gauge({
  name: 'queue_throughput_per_second',
  help: 'Items processed per second (rolling 1-minute average)',
  labelNames: ['queue_name'] as const,
  registers: [register],
})

export const workerSaturation = new client.Gauge({
  name: 'worker_saturation',
  help: 'Worker utilization as a percentage (0-100)',
  labelNames: ['worker_type'] as const,
  registers: [register],
})

export const workerActiveCount = new client.Gauge({
  name: 'worker_active_count',
  help: 'Number of currently active workers',
  labelNames: ['worker_type'] as const,
  registers: [register],
})

export const workerIdleCount = new client.Gauge({
  name: 'worker_idle_count',
  help: 'Number of currently idle workers',
  labelNames: ['worker_type'] as const,
  registers: [register],
})

export const workerProcessingDuration = new client.Histogram({
  name: 'worker_processing_duration_seconds',
  help: 'Duration of worker task processing in seconds',
  labelNames: ['worker_type', 'queue_name'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
})

export const queueProcessingErrorsTotal = new client.Counter({
  name: 'queue_processing_errors_total',
  help: 'Total number of queue processing errors',
  labelNames: ['queue_name', 'error_type'] as const,
  registers: [register],
})

export const queueBlockedSeconds = new client.Gauge({
  name: 'queue_blocked_seconds',
  help: 'Time in seconds the queue has been blocked (unable to process)',
  labelNames: ['queue_name'] as const,
  registers: [register],
})

/**
 * Record queue lag (age of oldest item)
 */
export function recordQueueLag(queueName: string, lagSeconds: number): void {
  queueLagSeconds.set({ queue_name: queueName }, lagSeconds)
}

/**
 * Record queue depth (number of items)
 */
export function recordQueueDepth(queueName: string, depth: number): void {
  queueDepth.set({ queue_name: queueName }, depth)
}

/**
 * Record queue throughput (items per second)
 */
export function recordQueueThroughput(queueName: string, throughput: number): void {
  queueThroughputPerSecond.set({ queue_name: queueName }, throughput)
}

/**
 * Record worker saturation (utilization percentage)
 */
export function recordWorkerSaturation(
  workerType: string,
  saturation: number
): void {
  workerSaturation.set({ worker_type: workerType }, saturation)
}

/**
 * Record active worker count
 */
export function recordWorkerActiveCount(
  workerType: string,
  count: number
): void {
  workerActiveCount.set({ worker_type: workerType }, count)
}

/**
 * Record idle worker count
 */
export function recordWorkerIdleCount(
  workerType: string,
  count: number
): void {
  workerIdleCount.set({ worker_type: workerType }, count)
}

/**
 * Record worker processing duration
 */
export function recordWorkerProcessingDuration(
  workerType: string,
  queueName: string,
  durationSeconds: number
): void {
  workerProcessingDuration.observe(
    { worker_type: workerType, queue_name: queueName },
    durationSeconds
  )
}

/**
 * Record queue processing error
 */
export function recordQueueProcessingError(
  queueName: string,
  errorType: string
): void {
  queueProcessingErrorsTotal.inc({ queue_name: queueName, error_type: errorType })
}

/**
 * Record queue blocked time
 */
export function recordQueueBlocked(queueName: string, blockedSeconds: number): void {
  queueBlockedSeconds.set({ queue_name: queueName }, blockedSeconds)
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
