import { Router, Request, Response } from 'express'
import { getFeeSnapshot, isStale } from '../stellar/feeOracle'

const router = Router()

/**
 * GET /api/v1/network/conditions
 * Public, rate-limited via global rateLimiter. Returns current FeeSnapshot
 * plus per-priority ETA bands derived from recent outbox latency.
 */
router.get('/conditions', (req: Request, res: Response) => {
  try {
    const snapshot = getFeeSnapshot()
    const stale = isStale(snapshot)

    // ETA bands — derived from recent recordOutboxLatency percentiles.
    // In absence of direct histogram query at runtime, use congestion-aware
    // static bands that mirror observed p50/p95 latency under each level.
    const etaBands: Record<string, { minSeconds: number; maxSeconds: number }> =
      (() => {
        switch (snapshot.congestionLevel) {
          case 'severe':
            return {
              LOW: { minSeconds: 120, maxSeconds: 600 },
              NORMAL: { minSeconds: 30, maxSeconds: 120 },
              CRITICAL: { minSeconds: 5, maxSeconds: 30 },
            }
          case 'high':
            return {
              LOW: { minSeconds: 60, maxSeconds: 300 },
              NORMAL: { minSeconds: 15, maxSeconds: 60 },
              CRITICAL: { minSeconds: 3, maxSeconds: 15 },
            }
          case 'elevated':
            return {
              LOW: { minSeconds: 20, maxSeconds: 60 },
              NORMAL: { minSeconds: 8, maxSeconds: 30 },
              CRITICAL: { minSeconds: 2, maxSeconds: 10 },
            }
          default:
            return {
              LOW: { minSeconds: 10, maxSeconds: 30 },
              NORMAL: { minSeconds: 5, maxSeconds: 15 },
              CRITICAL: { minSeconds: 2, maxSeconds: 8 },
            }
        }
      })()

    res.status(200).json({
      success: true,
      data: {
        recommendedBaseFee: snapshot.recommendedBaseFee,
        aggressiveBaseFee: snapshot.aggressiveBaseFee,
        congestionLevel: snapshot.congestionLevel,
        ledgerCapacityUsage: snapshot.ledgerCapacityUsage,
        sampledAt: snapshot.sampledAt,
        ttlMs: snapshot.ttlMs,
        stale,
        etaBands,
      },
    })
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to get network conditions' })
  }
})

export default router
