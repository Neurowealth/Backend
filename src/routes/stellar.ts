import { Router, Request, Response } from 'express'
import { getEventMetrics } from '../stellar/events'

const router = Router()

/**
 * GET /api/stellar/metrics
 * Returns current event-processing metrics from the Stellar event listener.
 */
router.get('/metrics', (_req: Request, res: Response) => {
  try {
    const metrics = getEventMetrics()
    res.json({
      success: true,
      data: metrics,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

export default router
