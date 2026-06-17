/**
 * src/utils/rpc-metrics.ts
 *
 * Prometheus counters and histograms for Stellar RPC health.
 * Imported by client.ts and exposed via the existing /metrics route.
 *
 * Metrics registered here:
 *   stellar_rpc_attempts_total          — every attempt, labelled by endpoint / context / primary
 *   stellar_rpc_failovers_total         — incremented when falling back to a secondary endpoint
 *   stellar_rpc_circuit_open_total      — incremented when a circuit breaker blocks a request
 *   stellar_rpc_request_duration_seconds — latency histogram, labelled by endpoint / context / success
 */

import { Counter, Histogram, Registry } from 'prom-client';

// Re-use the default registry so the existing getMetrics() picks these up
// automatically — no changes needed in metrics.ts or the /metrics route.
import { register } from './metrics-registry';

export const rpcAttemptCounter = new Counter({
  name: 'stellar_rpc_attempts_total',
  help: 'Total Stellar RPC call attempts',
  labelNames: ['endpoint', 'context', 'primary'] as const,
  registers: [register],
});

export const rpcFailoverCounter = new Counter({
  name: 'stellar_rpc_failovers_total',
  help: 'Number of times a call failed over to a secondary RPC endpoint',
  labelNames: ['endpoint', 'context'] as const,
  registers: [register],
});

export const rpcCircuitOpenCounter = new Counter({
  name: 'stellar_rpc_circuit_open_total',
  help: 'Number of requests blocked because the circuit breaker was OPEN',
  labelNames: ['endpoint', 'context'] as const,
  registers: [register],
});

export const rpcLatencyHistogram = new Histogram({
  name: 'stellar_rpc_request_duration_seconds',
  help: 'Latency of Stellar RPC requests in seconds',
  labelNames: ['endpoint', 'context', 'success'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});