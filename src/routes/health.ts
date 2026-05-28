import { Router, Request, Response } from 'express'
import { getReadiness } from '../config/readiness'

const router = Router()

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  })
})

/**
 * Readiness probe. Returns 503 until the event listener, agent loop, and DB
 * are all up — load balancers / k8s should hit this rather than `/`.
 */
router.get('/ready', (req: Request, res: Response) => {
  const { ready, subsystems } = getReadiness()
  res.status(ready ? 200 : 503).json({
    ready,
    subsystems,
    timestamp: new Date().toISOString(),
  })
})

export default router
