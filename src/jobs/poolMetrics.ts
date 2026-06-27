import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config/env'
import {
  dbPoolSize,
  dbPoolActive,
  dbPoolIdle,
  dbPoolWaitCount,
  dbPoolWaitDurationMs,
} from '../utils/metrics'

/**
 * Prisma connection-pool monitoring.
 *
 * Prisma exposes pool internals via prisma.$metrics.json() when the "metrics"
 * preview feature is enabled (see prisma/schema.prisma). We poll it on an
 * interval and mirror the values into Prometheus gauges so the pool is visible
 * on /metrics and can be alerted on (see deploy/monitoring/prometheus).
 *
 * The $metrics API is feature-flagged, so we feature-detect and degrade
 * gracefully if it is unavailable (e.g. client generated without the flag).
 */

interface PrismaMetric<T> {
  key: string
  labels: Record<string, string>
  value: T
}

interface PrismaMetricsJson {
  counters: PrismaMetric<number>[]
  gauges: PrismaMetric<number>[]
  histograms: PrismaMetric<{ buckets: [number, number][]; sum: number; count: number }>[]
}

type MetricsCapableClient = {
  $metrics?: { json: () => Promise<PrismaMetricsJson> }
}

function hasMetricsApi(client: unknown): client is Required<MetricsCapableClient> {
  const candidate = client as MetricsCapableClient
  return typeof candidate.$metrics?.json === 'function'
}

/**
 * Poll Prisma pool metrics once and sync them to the Prometheus gauges.
 * Never throws — failures are logged and the gauges keep their last value.
 */
export async function collectPoolMetrics(): Promise<void> {
  if (!hasMetricsApi(db)) {
    return
  }

  try {
    const metrics = await db.$metrics.json()

    const gauge = (key: string): number =>
      metrics.gauges.find((m) => m.key === key)?.value ?? 0
    const histogramSum = (key: string): number =>
      metrics.histograms.find((m) => m.key === key)?.value.sum ?? 0

    dbPoolSize.set(gauge('prisma_pool_connections_open'))
    dbPoolActive.set(gauge('prisma_pool_connections_busy'))
    dbPoolIdle.set(gauge('prisma_pool_connections_idle'))
    dbPoolWaitCount.set(gauge('prisma_client_queries_wait'))
    dbPoolWaitDurationMs.set(histogramSum('prisma_client_queries_wait_histogram_ms'))
  } catch (error) {
    logger.warn('[PoolMetrics] Failed to collect Prisma pool metrics', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Schedule pool-metrics collection on a fixed interval.
 *
 * @returns A NodeJS.Timeout handle (call clearInterval to stop it).
 */
export function schedulePoolMetrics(): NodeJS.Timeout {
  const intervalMs = config.database.poolMetricsIntervalMs

  // Prime the gauges immediately so /metrics is populated before the first tick
  void collectPoolMetrics()

  const handle = setInterval(() => {
    void collectPoolMetrics()
  }, intervalMs)

  // Don't keep the event loop alive solely for metrics polling
  handle.unref?.()

  logger.info(`[PoolMetrics] Prisma pool metrics polling scheduled (every ${intervalMs}ms)`)
  return handle
}
