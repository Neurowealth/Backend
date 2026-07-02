import { Router, Request, Response } from 'express'
import { getReadiness } from '../config/readiness'
import db from '../db'
import { getResilientClient } from '../stellar/client'
import twilio from 'twilio'
import { config } from '../config'
import { getAgentStatus } from '../agent/loop'
import pkg from '../../package.json'

const router = Router()

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: pkg.version || '1.0.0',
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

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ])
}

router.get('/deep', async (req: Request, res: Response) => {
  const token = req.headers['x-internal-token'] || req.headers['authorization']?.replace('Bearer ', '')
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN

  if (!expectedToken || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const startDb = Date.now()
  const checkDatabase = async (): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs: number; error?: string }> => {
    try {
      await withTimeout(db.$queryRaw`SELECT 1`, 3000, 'database')
      return { status: 'healthy', latencyMs: Date.now() - startDb }
    } catch (error: any) {
      return { status: 'unhealthy', latencyMs: Date.now() - startDb, error: error.message }
    }
  }

  const startStellar = Date.now()
  const checkStellarRpc = async (): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs: number; ledger?: number; error?: string }> => {
    try {
      const client = getResilientClient()
      const latestLedger = await withTimeout(
        client.execute(server => server.getLatestLedger(), 'health-check'),
        3000,
        'stellarRpc'
      )
      return { status: 'healthy', latencyMs: Date.now() - startStellar, ledger: latestLedger.sequence }
    } catch (error: any) {
      return { status: 'unhealthy', latencyMs: Date.now() - startStellar, error: error.message }
    }
  }

  const startTwilio = Date.now()
  const checkTwilio = async (): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs: number; error?: string }> => {
    try {
      const sid = config.whatsapp.twilioSid
      const twilioToken = config.whatsapp.twilioToken
      if (!sid || !twilioToken) {
        throw new Error('Twilio credentials not configured')
      }
      const client = twilio(sid, twilioToken)
      await withTimeout(
        client.api.accounts(sid).fetch(),
        3000,
        'twilio'
      )
      return { status: 'healthy', latencyMs: Date.now() - startTwilio }
    } catch (error: any) {
      return { status: 'unhealthy', latencyMs: Date.now() - startTwilio, error: error.message }
    }
  }

  const checkAgentLoop = () => {
    try {
      const status = getAgentStatus()
      const TICK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
      let checkStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'

      if (!status.isRunning) {
        checkStatus = 'unhealthy'
      } else if (!status.lastTickAt) {
        checkStatus = 'unhealthy'
      } else {
        const timeSinceLastTick = Date.now() - new Date(status.lastTickAt).getTime()
        if (timeSinceLastTick > 2 * TICK_INTERVAL_MS) {
          checkStatus = 'unhealthy'
        } else if (status.lastError || status.healthStatus === 'degraded') {
          checkStatus = 'degraded'
        }
      }

      return {
        status: checkStatus,
        lastTickAt: status.lastTickAt ? status.lastTickAt.toISOString() : null
      }
    } catch (error: any) {
      return { status: 'unhealthy' as const, lastTickAt: null, error: error.message }
    }
  }

  const [dbResult, stellarResult, twilioResult] = await Promise.all([
    checkDatabase(),
    checkStellarRpc(),
    checkTwilio()
  ])
  const agentResult = checkAgentLoop()

  const hasUnhealthy =
    dbResult.status === 'unhealthy' ||
    stellarResult.status === 'unhealthy' ||
    twilioResult.status === 'unhealthy' ||
    agentResult.status === 'unhealthy'

  const hasDegraded =
    dbResult.status === 'degraded' ||
    stellarResult.status === 'degraded' ||
    twilioResult.status === 'degraded' ||
    agentResult.status === 'degraded'

  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
  if (hasUnhealthy) {
    overallStatus = 'unhealthy'
  } else if (hasDegraded) {
    overallStatus = 'degraded'
  }

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200

  return res.status(statusCode).json({
    status: overallStatus,
    version: pkg.version || '1.0.0',
    uptime: Math.floor(process.uptime()),
    checks: {
      database: dbResult,
      stellarRpc: stellarResult,
      twilio: twilioResult,
      agentLoop: agentResult
    }
  })
})

export default router
