/**
 * Adaptive base-fee oracle (#342) — samples recent ledger fee stats and
 * publishes a hysteresis-smoothed congestion signal for the dispatcher and API.
 */

import { config } from '../config/env'
import { getResilientClient } from './client'
import { cacheGet, cacheSet } from '../config/redis'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import {
  feeOracleRecommendedBaseFee,
  feeOracleAggressiveBaseFee,
  feeOracleLedgerCapacityUsage,
  feeOracleCongestionLevel,
  feeOracleStalenessSeconds,
  recordFeeOracleClamp,
} from '../utils/metrics'

export type CongestionLevel = 'low' | 'elevated' | 'high' | 'severe'

export interface FeeSnapshot {
  recommendedBaseFee: number
  aggressiveBaseFee: number
  congestionLevel: CongestionLevel
  ledgerCapacityUsage: number
  sampledAt: string
  ttlMs: number
}

const REDIS_KEY = 'fee-oracle:snapshot'
const HISTORY_MAX = 20
const DWELL_MS = 30000

const LEVEL_NUM: Record<CongestionLevel, number> = {
  low: 0,
  elevated: 1,
  high: 2,
  severe: 3,
}
const NUM_LEVEL: Record<number, CongestionLevel> = {
  0: 'low',
  1: 'elevated',
  2: 'high',
  3: 'severe',
}

let currentSnapshot: FeeSnapshot | null = null
let history: number[] = []
let currentLevel: CongestionLevel = 'low'
let levelSinceMs = Date.now()
let pollHandle: NodeJS.Timeout | null = null
let started = false

function clampFee(value: number): number {
  const min = config.feeOracle.min
  const max = config.feeOracle.max
  if (value < min) {
    recordFeeOracleClamp('min')
    return min
  }
  if (value > max) {
    recordFeeOracleClamp('max')
    return max
  }
  return value
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return config.feeOracle.defaultBaseFee
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!
}

function capacityLevel(capacity: number): number {
  if (capacity >= 0.85) return 3
  if (capacity >= 0.7) return 2
  if (capacity >= 0.5) return 1
  return 0
}

function feeLevel(minFee: number, p95Fee: number): number {
  if (minFee <= 0) return 0
  const ratio = p95Fee / minFee
  if (ratio >= 3) return 3
  if (ratio >= 2) return 2
  if (ratio >= 1.5) return 1
  return 0
}

export function deriveCongestionLevel(
  capacity: number,
  minFee: number,
  p95Fee: number,
  prev: CongestionLevel,
  dwellOk: boolean
): CongestionLevel {
  const rawNum = Math.max(capacityLevel(capacity), feeLevel(minFee, p95Fee))
  const prevNum = LEVEL_NUM[prev]
  if (rawNum !== prevNum && !dwellOk) return prev
  return NUM_LEVEL[rawNum]!
}

function defaultSnapshot(): FeeSnapshot {
  const now = new Date().toISOString()
  return {
    recommendedBaseFee: config.feeOracle.defaultBaseFee,
    aggressiveBaseFee: config.feeOracle.defaultBaseFee,
    congestionLevel: 'low',
    ledgerCapacityUsage: 0,
    sampledAt: now,
    ttlMs: config.feeOracle.ttlMs,
  }
}

export function isStale(snapshot: FeeSnapshot, nowMs = Date.now()): boolean {
  const sampled = new Date(snapshot.sampledAt).getTime()
  // small grace 1s for clock skew
  return nowMs - sampled > snapshot.ttlMs + 1000
}

async function fetchFeeStats(): Promise<{ min: number; p70: number; p95: number }> {
  const client = getResilientClient()
  // Try getFeeStats via resilient execute; fallback to raw server
  const raw: any = await client.execute(
    async (server: any) => {
      if (typeof server.getFeeStats === 'function') return server.getFeeStats()
      throw new Error('getFeeStats not available')
    },
    'feeOracle.getFeeStats'
  )
  // Stellar RPC FeeStats shape varies: handle multiple shapes
  // sorobanInclusionFee: { min, p70, p95 } or feeCharged: { min, p70, p95 }
  const inclusion = raw?.sorobanInclusionFee ?? raw?.feeCharged ?? raw
  const min = Number(inclusion?.min ?? inclusion?.p10 ?? 0)
  const p70 = Number(inclusion?.p70 ?? inclusion?.p60 ?? inclusion?.mode ?? min)
  const p95 = Number(inclusion?.p95 ?? inclusion?.p90 ?? p70)
  return { min, p70, p95 }
}

async function fetchLedgerCapacity(): Promise<number> {
  const client = getResilientClient()
  const ledger: any = await client.execute(
    async (server: any) => server.getLatestLedger(),
    'feeOracle.getLatestLedger'
  )
  // ledgerCapacityUsage 0..1 may be in ledger, or feeStats; fallback
  if (typeof ledger?.ledgerCapacityUsage === 'number') return ledger.ledgerCapacityUsage
  if (typeof ledger?.sequence === 'number' && typeof ledger?.protocolVersion === 'number') {
    // fallback: use tx count heuristic if available
    if (typeof ledger?.txCount === 'number' && typeof ledger?.maxTxSetSize === 'number' && ledger.maxTxSetSize > 0) {
      return Math.min(1, ledger.txCount / ledger.maxTxSetSize)
    }
  }
  return 0
}

async function pollOnce(): Promise<void> {
  try {
    const [stats, capacity] = await Promise.all([fetchFeeStats(), fetchLedgerCapacity()])

    let p70 = stats.p70
    let p95 = stats.p95
    const min = stats.min

    // degenerate check: if all equal or absurdly high, clamp will handle
    if (!Number.isFinite(p70) || p70 <= 0) p70 = config.feeOracle.defaultBaseFee
    if (!Number.isFinite(p95) || p95 <= 0) p95 = p70

    history.push(p70)
    if (history.length > HISTORY_MAX) history.shift()

    const sorted = [...history].sort((a, b) => a - b)
    const recommended = clampFee(Math.max(100, percentile(sorted, 70) || p70))
    const aggressive = clampFee(Math.max(100, percentile(sorted, 95) || p95))

    const dwellOk = Date.now() - levelSinceMs >= DWELL_MS
    const nextLevel = deriveCongestionLevel(capacity, min, p95, currentLevel, dwellOk)
    if (nextLevel !== currentLevel) {
      currentLevel = nextLevel
      levelSinceMs = Date.now()
    }

    const snapshot: FeeSnapshot = {
      recommendedBaseFee: recommended,
      aggressiveBaseFee: aggressive,
      congestionLevel: currentLevel,
      ledgerCapacityUsage: Math.max(0, Math.min(1, capacity)),
      sampledAt: new Date().toISOString(),
      ttlMs: config.feeOracle.ttlMs,
    }

    currentSnapshot = snapshot

    feeOracleRecommendedBaseFee.set(recommended)
    feeOracleAggressiveBaseFee.set(aggressive)
    feeOracleLedgerCapacityUsage.set(snapshot.ledgerCapacityUsage)
    feeOracleCongestionLevel.set(LEVEL_NUM[currentLevel]!)
    feeOracleStalenessSeconds.set(0)

    // Redis mirror best-effort
    await cacheSet(REDIS_KEY, snapshot, Math.ceil(snapshot.ttlMs / 1000) + 5).catch(() => {})

    logger.info('[FeeOracle] Snapshot published', {
      recommendedBaseFee: recommended,
      aggressiveBaseFee: aggressive,
      congestionLevel: currentLevel,
      ledgerCapacityUsage: snapshot.ledgerCapacityUsage,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('[FeeOracle] Poll failed', { error: msg })
    // staleness metric
    if (currentSnapshot) {
      const staleness = (Date.now() - new Date(currentSnapshot.sampledAt).getTime()) / 1000
      feeOracleStalenessSeconds.set(Math.max(0, staleness))
      if (staleness * 1000 > config.feeOracle.ttlMs) {
        alertingService
          .emit(
            {
              title: 'Fee oracle stale',
              description: `Fee oracle has not produced a fresh snapshot for ${Math.round(staleness)}s (TTL ${config.feeOracle.ttlMs}ms). Consumers falling back to default fee.`,
              severity: 'warning',
              component: 'fee-oracle',
              metadata: { stalenessSeconds: staleness, ttlMs: config.feeOracle.ttlMs },
            },
            'fee-oracle:stale'
          )
          .catch(() => {})
      }
    } else {
      feeOracleStalenessSeconds.set(config.feeOracle.ttlMs / 1000)
    }
  }
}

export function getFeeSnapshot(): FeeSnapshot {
  // Try in-memory, then Redis mirror (best-effort sync not possible; return in-memory or default)
  if (currentSnapshot && !isStale(currentSnapshot)) {
    return currentSnapshot
  }
  // cold start or stale → fallback default, do not silently reuse stale
  return defaultSnapshot()
}

// For tests: inject snapshot directly
export function __setSnapshotForTest(snapshot: FeeSnapshot | null): void {
  currentSnapshot = snapshot
  if (snapshot) {
    feeOracleRecommendedBaseFee.set(snapshot.recommendedBaseFee)
    feeOracleAggressiveBaseFee.set(snapshot.aggressiveBaseFee)
    feeOracleLedgerCapacityUsage.set(snapshot.ledgerCapacityUsage)
    feeOracleCongestionLevel.set(LEVEL_NUM[snapshot.congestionLevel]!)
  }
}

export function __resetForTest(): void {
  currentSnapshot = null
  history = []
  currentLevel = 'low'
  levelSinceMs = Date.now()
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  started = false
}

export async function startFeeOracle(): Promise<void> {
  if (started) return
  started = true

  // Try to hydrate from Redis (best-effort)
  try {
    const cached = await cacheGet<FeeSnapshot>(REDIS_KEY)
    if (cached && cached.sampledAt && !isStale(cached)) {
      currentSnapshot = cached
      currentLevel = cached.congestionLevel
      feeOracleRecommendedBaseFee.set(cached.recommendedBaseFee)
      feeOracleAggressiveBaseFee.set(cached.aggressiveBaseFee)
      feeOracleLedgerCapacityUsage.set(cached.ledgerCapacityUsage)
      feeOracleCongestionLevel.set(LEVEL_NUM[cached.congestionLevel]!)
    }
  } catch {}

  await pollOnce()
  pollHandle = setInterval(() => {
    void pollOnce()
  }, config.feeOracle.pollMs)
  // allow process to exit if only this timer remains
  if (pollHandle.unref) pollHandle.unref()
  logger.info('[FeeOracle] Started', { pollMs: config.feeOracle.pollMs })
}

export function stopFeeOracle(): void {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  started = false
  logger.info('[FeeOracle] Stopped')
}
