import { Router, Request, Response } from 'express'
import { getReadiness } from '../config/readiness'
import db from '../db'
import { getResilientClient } from '../stellar/client'
import twilio from 'twilio'
import { config } from '../config'
import { getAgentStatus } from '../agent/loop'
import pkg from '../../package.json'
import { redactSensitiveData } from '../utils/logger'
import { recordHealthDependency } from '../utils/metrics'

const router = Router()

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: pkg.version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
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

type CheckStatus = 'healthy' | 'degraded' | 'unhealthy'
type Criticality = 'critical' | 'non-critical'

interface CheckOutcome {
  status: CheckStatus
  [detail: string]: unknown
}

interface CheckResult extends CheckOutcome {
  latencyMs: number
  error?: string
}

/**
 * Per-dependency readiness policy (see docs/DEPLOYMENT.md#health-probes).
 *
 * Critical dependencies are local to the pod: when they fail, pulling this
 * instance out of rotation helps. Non-critical dependencies are shared
 * external services: if one is down it is down for every replica, so failing
 * readiness would drain the whole fleet. They report `degraded` instead.
 */
export const DEPENDENCY_POLICY: Record<string, Criticality> = {
  database: 'critical',
  agentLoop: 'critical',
  stellarRpc: 'non-critical',
  twilio: 'non-critical',
}

/** Per-check budget; keeps the aggregate probe well under the k8s 5s timeout. */
export const HEALTH_CHECK_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000
})()

const MAX_ERROR_LENGTH = 200

// Bounded, redacted error detail so probe responses never leak secrets.
const safeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  const redacted = redactSensitiveData(message)
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted
}

const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  name: string
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Run one dependency check under the per-check budget. Never rejects: a
 * throw or a timeout becomes an `unhealthy` result.
 */
const runCheck = async (
  name: string,
  check: () => Promise<CheckOutcome>
): Promise<CheckResult> => {
  const start = Date.now()
  let result: CheckResult
  try {
    const outcome = await withTimeout(
      Promise.resolve().then(check),
      HEALTH_CHECK_TIMEOUT_MS,
      name
    )
    result = { ...outcome, latencyMs: Date.now() - start }
  } catch (error) {
    result = {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: safeError(error),
    }
  }
  recordHealthDependency(
    name,
    DEPENDENCY_POLICY[name] ?? 'non-critical',
    result.status,
    result.latencyMs
  )
  return result
}

const checkDatabase = async () => {
  await db.$queryRaw`SELECT 1`
  return { status: 'healthy' as const }
}

const checkStellarRpc = async () => {
  const client = getResilientClient()
  const latestLedger = await client.execute(
    (server) => server.getLatestLedger(),
    'health-check'
  )
  return { status: 'healthy' as const, ledger: latestLedger.sequence }
}

const checkTwilio = async () => {
  const sid = config.whatsapp.twilioSid
  const twilioToken = config.whatsapp.twilioToken
  if (!sid || !twilioToken) {
    throw new Error('Twilio credentials not configured')
  }
  const client = twilio(sid, twilioToken)
  await client.api.accounts(sid).fetch()
  return { status: 'healthy' as const }
}

const checkAgentLoop = async () => {
  const status = getAgentStatus()
  const TICK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
  let checkStatus: CheckStatus = 'healthy'

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
    lastTickAt: status.lastTickAt ? status.lastTickAt.toISOString() : null,
  }
}

router.get('/deep', async (req: Request, res: Response) => {
  const token =
    req.headers['x-internal-token'] ||
    req.headers['authorization']?.replace('Bearer ', '')
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN

  if (!expectedToken || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // All checks run in parallel and each is individually bounded, so total
  // probe latency is ~HEALTH_CHECK_TIMEOUT_MS even if a dependency hangs.
  const [database, stellarRpc, twilioResult, agentLoop] = await Promise.all([
    runCheck('database', checkDatabase),
    runCheck('stellarRpc', checkStellarRpc),
    runCheck('twilio', checkTwilio),
    runCheck('agentLoop', checkAgentLoop),
  ])
  const checks: Record<string, CheckResult> = {
    database,
    stellarRpc,
    twilio: twilioResult,
    agentLoop,
  }

  const degradedDependencies = Object.entries(checks)
    .filter(([, result]) => result.status !== 'healthy')
    .map(([name]) => name)

  const criticalFailure = Object.entries(checks).some(
    ([name, result]) =>
      result.status === 'unhealthy' && DEPENDENCY_POLICY[name] === 'critical'
  )

  let overallStatus: CheckStatus = 'healthy'
  if (criticalFailure) {
    overallStatus = 'unhealthy'
  } else if (degradedDependencies.length > 0) {
    overallStatus = 'degraded'
  }

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200

  return res.status(statusCode).json({
    status: overallStatus,
    version: pkg.version || '1.0.0',
    uptime: Math.floor(process.uptime()),
    degradedDependencies,
    checks,
  })
})

export default router
