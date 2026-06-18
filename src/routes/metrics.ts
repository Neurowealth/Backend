import { Router, Request, Response } from 'express'
import { getMetrics } from '../utils/metrics'
import { internalAuthGuardStrict } from '../middleware/authGuard'

const router = Router()

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint for observability
 *
 * PROTECTED: Requires one of:
 * - X-Internal-Token header matching INTERNAL_SERVICE_TOKEN
 * - Client IP in INTERNAL_IP_WHITELIST
 * - Bearer token matching ADMIN_API_TOKEN
 *
 * Returns 404 if unauthorized (info hiding mode)
 *
 * Metrics include:
 * - Event processing counters and histograms
 * - Failure metrics
 * - DLQ size
 * - Cursor lag
 * - Agent loop heartbeat
 * - Database operation metrics
 * - HTTP request metrics
 * - Analytics API metrics
 */
router.get('/', internalAuthGuardStrict, async (_req: Request, res: Response) => {
  try {
    const metrics = await getMetrics()
    res.set('Content-Type', 'text/plain')
    res.status(200).send(metrics)
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve metrics' })
  }
})

export default router
