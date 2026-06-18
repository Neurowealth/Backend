/**
 * Agent Routes - API endpoints for agent control and monitoring
 */
import express, { Request, Response } from 'express'
import { getAgentStatus } from '../agent/loop'
import { internalAuthGuard } from '../middleware/authGuard'

const router = express.Router()

/**
 * GET /api/agent/status
 * Returns current agent status and health information
 *
 * PROTECTED: Requires one of:
 * - X-Internal-Token header matching INTERNAL_SERVICE_TOKEN
 * - Client IP in INTERNAL_IP_WHITELIST
 * - Bearer token matching ADMIN_API_TOKEN
 *
 * Returns 403 if unauthorized
 */
router.get('/status', internalAuthGuard, (req: Request, res: Response) => {
  try {
    const status = getAgentStatus()
    res.json({
      success: true,
      data: {
        isRunning: status.isRunning,
        lastRebalanceAt: status.lastRebalanceAt,
        currentProtocol: status.currentProtocol,
        currentApy: status.currentApy ? status.currentApy.toFixed(2) : null,
        nextScheduledCheck: status.nextScheduledCheck,
        lastError: status.lastError,
        healthStatus: status.healthStatus,
        timestamp: new Date().toISOString(),
      },
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

export default router
