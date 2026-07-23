/**
 * ── Telemetry bootstrap ───────────────────────────────────────────────────────
 *
 * These two imports MUST come before everything else.
 *
 * OTel patches Node.js core modules and popular libraries (Express, Prisma,
 * http) at require-time via monkey-patching.  Any library imported before the
 * SDK starts will not be instrumented.
 *
 * Sentry's init() must also run before route/middleware imports so the
 * automatic request/breadcrumb instrumentation is registered.
 */
import './telemetry/otel' // 1. OpenTelemetry — distributed tracing
import './telemetry/sentry' // 2. Sentry       — error reporting

// ── Standard imports ──────────────────────────────────────────────────────────

import { type Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import express, { Request, Response } from 'express'
import * as Sentry from '@sentry/node'
import swaggerUi from 'swagger-ui-express'
import yaml from 'js-yaml'
import { config } from './config/env'
import { errorHandler } from './middleware/errorHandler'
import { correlationIdMiddleware } from './middleware/correlationId'
import { requestLogger } from './middleware/logger'
import { requestTimeoutMiddleware } from './middleware/requestTimeout'
import {
  rateLimiter,
  authRateLimiter,
  adminRateLimiter,
  internalRateLimiter,
  webhookRateLimiter,
  trustedIpBypass,
} from './middleware/rateLimiter'
import {
  configureTrustProxy,
  securityHeaders,
  permissionsPolicy,
} from './middleware/security'
import { logger } from './utils/logger'
import { startAgentLoop, stopAgentLoop } from './agent/loop'
import { connectDb } from './db'
import { scheduleSessionCleanup } from './jobs/sessionCleanup'
import { scheduleDataRetention } from './jobs/dataRetention'
import { schedulePoolMetrics } from './jobs/poolMetrics'
import { scheduleFiatReconciliation } from './jobs/fiatReconciliation'
import { scheduleReferralPayout } from './jobs/referralPayout'
import { scheduleAlertRules } from './jobs/alertRules'
import { startEventListener, stopEventListener } from './stellar/events'
import { validateStellarNetworkReady } from './config/readiness'
import healthRouter from './routes/health'
import agentRouter from './routes/agent'
import authRouter from './routes/auth'
import whatsappRouter from './routes/whatsapp'
import portfolioRouter from './routes/portfolio'
import transactionsRouter from './routes/transactions'
import protocolsRouter from './routes/protocols'
import depositRouter from './routes/deposit'
import withdrawRouter from './routes/withdraw'
import vaultRouter from './routes/vault'
import analyticsRouter from './routes/analytics'
import adminRouter from './routes/admin'
import metricsRouter from './routes/metrics'
import stellarRouter from './routes/stellar'
import webhooksRouter from './routes/webhooks'
import fiatRouter from './routes/fiat'
import referralsRouter from './routes/referrals'
import alertsRouter from './routes/alerts'
import {
  corsMiddleware,
  jsonBodyParser,
  payloadSizeErrorHandler,
  urlencodedBodyParser,
  contentTypeRestrictionMiddleware,
} from './middleware/corsandbody'
import { setSpanUser } from './telemetry/spans'

// ── Readiness state ───────────────────────────────────────────────────────────

interface ServiceStatus {
  ready: boolean
  error?: string
}

const serviceStatus: Record<string, ServiceStatus> = {
  database: { ready: false },
  eventListener: { ready: false },
  agentLoop: { ready: false },
}

let isShuttingDown = false
let httpServer: Server | null = null
let sessionCleanupHandle: NodeJS.Timeout | null = null
let dataRetentionHandle: NodeJS.Timeout | null = null
let poolMetricsHandle: NodeJS.Timeout | null = null
let fiatReconciliationHandle: NodeJS.Timeout | null = null
let referralPayoutHandle: NodeJS.Timeout | null = null
let alertRulesHandle: NodeJS.Timeout | null = null

function allServicesReady(): boolean {
  return Object.values(serviceStatus).every((s) => s.ready)
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express()

configureTrustProxy(app)

// ── Security and parsing middleware ───────────────────────────────────────────

app.disable('x-powered-by')
app.use(securityHeaders())
app.use(permissionsPolicy())
app.use(corsMiddleware)
app.use(contentTypeRestrictionMiddleware)
// Fiat provider webhooks are HMAC-signed over the raw request bytes. Capture the
// raw body BEFORE the global JSON parser so signature verification sees the exact
// payload — body-parser marks req._body here, so jsonBodyParser then skips these
// paths. Must precede jsonBodyParser.
app.use(
  ['/api/v1/fiat/webhook', '/api/fiat/webhook'],
  express.raw({ type: '*/*', limit: '1mb' })
)
app.use(jsonBodyParser)
app.use(urlencodedBodyParser)

// Correlation ID — must run before requestLogger
app.use(correlationIdMiddleware)

// ── User context propagation ──────────────────────────────────────────────────
//
// After the auth middleware resolves req.user, propagate the user ID to:
//  • The active OTel span  (so traces show which user was affected)
//  • The Sentry scope      (so Sentry issues show affected user counts)
//
// This middleware runs after correlation IDs are set but before route handlers.
// It is a no-op for unauthenticated requests.

app.use((req: Request & { user?: { id: string } }, _res: Response, next) => {
  if (req.user?.id) {
    // OTel span
    setSpanUser(req.user.id)
    // Sentry scope — user context persists for the life of the request
    Sentry.setUser({ id: req.user.id })
  }
  next()
})

app.use(requestLogger)
app.use(trustedIpBypass)
app.use(rateLimiter)
app.use(requestTimeoutMiddleware)

// Advertise the served API version on every response — must be registered
// before the first route (including the health probes below).
const API_VERSION = '1'
app.use((_req: Request, res: Response, next) => {
  res.setHeader('X-API-Version', API_VERSION)
  next()
})

// ── Readiness / liveness probes ───────────────────────────────────────────────

app.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() })
})

app.get('/health/ready', (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({
      status: 'shutting_down',
      services: serviceStatus,
      timestamp: new Date().toISOString(),
    })
  }

  if (allServicesReady()) {
    res.status(200).json({
      status: 'ready',
      services: serviceStatus,
      timestamp: new Date().toISOString(),
    })
  } else {
    res.status(503).json({
      status: 'not_ready',
      services: serviceStatus,
      timestamp: new Date().toISOString(),
    })
  }
})

// ── API versioning ────────────────────────────────────────────────────────────
//
// All /api/* routes are served under an explicit version prefix (/api/v1/*).
// The legacy unversioned paths (/api/*) remain mounted as deprecated aliases so
// existing clients keep working; they emit RFC 8594 Deprecation/Sunset headers
// announcing the removal date. See docs/api-versioning.md for the policy.

// Unversioned routes are supported for at least 6 months from this release.
const UNVERSIONED_SUNSET = new Date(
  Date.now() + 182 * 24 * 60 * 60 * 1000
).toUTCString()

// ── OpenAPI / Swagger UI ──────────────────────────────────────────────────────

let swaggerSpec: Record<string, unknown> | null = null
const specPath = path.join(process.cwd(), 'docs', 'openapi.yaml')

try {
  const specFile = fs.readFileSync(specPath, 'utf8')
  swaggerSpec = yaml.load(specFile) as Record<string, unknown>
  logger.info(`[OpenAPI] Spec loaded from ${specPath}`)
} catch (error) {
  logger.error('[OpenAPI] Failed to load spec', {
    error: error instanceof Error ? error.message : String(error),
  })
}

if (swaggerSpec) {
  const swaggerOpts = {
    customSiteTitle: 'NeuroWealth API Docs',
    customfavIcon: '/favicon.ico',
  }
  app.use(
    '/api/v1/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, swaggerOpts)
  )
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerOpts))
  app.use('/api/v1/openapi.yaml', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8')
    res.sendFile(specPath)
  })
  app.use('/openapi.yaml', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8')
    res.sendFile(specPath)
  })
}

// Marks legacy unversioned /api/* responses as deprecated.
function deprecatedApiWarning(
  req: Request,
  res: Response,
  next: express.NextFunction
): void {
  res.setHeader('Deprecation', 'true')
  res.setHeader('Sunset', UNVERSIONED_SUNSET)
  res.setHeader(
    'Link',
    `<${req.baseUrl.replace('/api/', '/api/v1/')}>; rel="successor-version"`
  )
  next()
}

interface ApiRoute {
  path: string
  handlers: express.RequestHandler[]
}

const apiRoutes: ApiRoute[] = [
  { path: 'agent', handlers: [internalRateLimiter, agentRouter] },
  { path: 'auth', handlers: [authRateLimiter, authRouter] },
  { path: 'whatsapp', handlers: [webhookRateLimiter, whatsappRouter] },
  { path: 'portfolio', handlers: [portfolioRouter] },
  { path: 'transactions', handlers: [transactionsRouter] },
  { path: 'protocols', handlers: [protocolsRouter] },
  { path: 'deposit', handlers: [depositRouter] },
  { path: 'withdraw', handlers: [withdrawRouter] },
  { path: 'vault', handlers: [vaultRouter] },
  { path: 'analytics', handlers: [analyticsRouter] },
  { path: 'stellar', handlers: [stellarRouter] },
  { path: 'fiat', handlers: [fiatRouter] },
  { path: 'referrals', handlers: [referralsRouter] },
  { path: 'alerts', handlers: [alertsRouter] },
  { path: 'admin', handlers: [adminRateLimiter, adminRouter] },
]

// ── Application routes ────────────────────────────────────────────────────────

app.use('/health', healthRouter)
app.use('/api/webhooks', webhooksRouter)
app.use('/metrics', metricsRouter)

// Primary, versioned mounts: /api/v1/*
for (const route of apiRoutes) {
  app.use(`/api/v1/${route.path}`, ...route.handlers)
}

// Legacy unversioned aliases: /api/* (deprecated, still functional)
for (const route of apiRoutes) {
  app.use(`/api/${route.path}`, deprecatedApiWarning, ...route.handlers)
}

// 413 handler — must be after body parsers, before generic error handler
app.use(payloadSizeErrorHandler)

// Generic error handler — must always be last
app.use(errorHandler)

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`[Shutdown] Received ${signal}, initiating graceful shutdown...`)
  isShuttingDown = true

  if (sessionCleanupHandle) {
    clearInterval(sessionCleanupHandle)
    sessionCleanupHandle = null
    logger.info('[Shutdown] Session cleanup timer cleared')
  }

  if (dataRetentionHandle) {
    clearInterval(dataRetentionHandle)
    dataRetentionHandle = null
    logger.info('[Shutdown] Data retention timer cleared')
  }

  if (poolMetricsHandle) {
    clearInterval(poolMetricsHandle)
    poolMetricsHandle = null
    logger.info('[Shutdown] Pool metrics timer cleared')
  }

  if (fiatReconciliationHandle) {
    clearInterval(fiatReconciliationHandle)
    fiatReconciliationHandle = null
    logger.info('[Shutdown] Fiat reconciliation timer cleared')
  }

  if (referralPayoutHandle) {
    clearInterval(referralPayoutHandle)
    referralPayoutHandle = null
    logger.info('[Shutdown] Referral payout timer cleared')
  }

  if (alertRulesHandle) {
    clearInterval(alertRulesHandle)
    alertRulesHandle = null
    logger.info('[Shutdown] Alert rules timer cleared')
  }

  if (!httpServer) {
    logger.warn('[Shutdown] No HTTP server to close')
    process.exit(0)
  }

  logger.info('[Shutdown] Closing HTTP server (no new requests accepted)')
  httpServer.close(async () => {
    logger.info('[Shutdown] HTTP server closed')

    try {
      logger.info('[Shutdown] Stopping event listener...')
      stopEventListener()

      logger.info('[Shutdown] Stopping agent loop...')
      await stopAgentLoop()

      logger.info('[Shutdown] Disconnecting Prisma...')
      const db = await import('./db').then((m) => m.default)
      await db.$disconnect()

      // Flush Sentry queue before exiting so no error events are dropped
      logger.info('[Shutdown] Flushing Sentry event queue...')
      await Sentry.flush(2_000)

      logger.info('[Shutdown] ✓ All services stopped gracefully')
      process.exit(0)
    } catch (error) {
      logger.error('[Shutdown] Error during graceful shutdown:', {
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    }
  })

  setTimeout(() => {
    logger.error('[Shutdown] Grace period exhausted, forcing shutdown...')
    process.exit(1)
  }, config.shutdown.drainTimeoutMs)
}

// ── Startup sequence ──────────────────────────────────────────────────────────

async function initServices(): Promise<void> {
  // 0. Bootstrap secrets (no-op when SECRET_BACKEND=env, fetches from SSM otherwise)
  const { bootstrapSecrets } = await import('./config/secrets')
  await bootstrapSecrets()

  if (config.nodeEnv === 'production') {
    logger.info(
      '[Startup] Admin access will use database-backed scoped credentials ✓'
    )
  }

  if (!process.env.TWILIO_AUTH_TOKEN) {
    const msg =
      'TWILIO_AUTH_TOKEN must be set — WhatsApp webhook signature validation requires it'
    logger.error(
      '[Startup] Configuration validation failed — cannot continue',
      { error: msg }
    )
    throw new Error(msg)
  }
  logger.info('[Startup] Twilio auth token configured ✓')

  // 0. Validate Stellar network configuration
  validateStellarNetworkReady()

  // 1. Database
  try {
    await connectDb()
    serviceStatus.database = { ready: true }
    logger.info('[Startup] Database connected ✓')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    serviceStatus.database = { ready: false, error: msg }
    logger.error('[Startup] Database connection failed — cannot continue', {
      error: msg,
    })
    throw new Error(`Database: ${msg}`)
  }

  // 2. Stellar event listener
  try {
    await startEventListener()
    serviceStatus.eventListener = { ready: true }
    logger.info('[Startup] Stellar event listener started ✓')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    serviceStatus.eventListener = { ready: false, error: msg }
    logger.error('[Startup] Event listener failed to start — cannot continue', {
      error: msg,
    })
    throw new Error(`EventListener: ${msg}`)
  }

  // 3. Agent loop
  try {
    await startAgentLoop()
    serviceStatus.agentLoop = { ready: true }
    logger.info('[Startup] Agent loop started ✓')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    serviceStatus.agentLoop = { ready: false, error: msg }
    logger.error('[Startup] Agent loop failed to start — cannot continue', {
      error: msg,
    })
    throw new Error(`AgentLoop: ${msg}`)
  }
}

async function main(): Promise<void> {
  logger.info(`[Startup] NeuroWealth backend initialising`)
  logger.info(
    `[Startup] NODE_ENV=${config.nodeEnv}  network=${config.stellar.network}  port=${config.port}`
  )

  try {
    await initServices()
  } catch (initError) {
    // Report startup failures to Sentry before exiting
    Sentry.captureException(initError, {
      tags: { phase: 'startup' },
      extra: {
        failedServices: Object.entries(serviceStatus).filter(
          ([, s]) => !s.ready
        ),
      },
    })
    await Sentry.flush(2_000)

    logger.error(
      '[Startup] One or more critical services failed to initialise:'
    )
    logger.error(
      Object.entries(serviceStatus)
        .filter(([, s]) => !s.ready)
        .map(([name, s]) => `  ✗ ${name}: ${s.error ?? 'unknown error'}`)
        .join('\n')
    )
    process.exit(1)
  }

  httpServer = app.listen(config.port, () => {
    logger.info(`[Startup] HTTP server listening on port ${config.port} ✓`)
    logger.info('[Startup] All systems operational — ready to serve requests')
  })

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  sessionCleanupHandle = scheduleSessionCleanup()
  dataRetentionHandle = scheduleDataRetention()
  poolMetricsHandle = schedulePoolMetrics()
  fiatReconciliationHandle = scheduleFiatReconciliation()
  referralPayoutHandle = scheduleReferralPayout()
  alertRulesHandle = scheduleAlertRules()
}

// ── Process-level error guards ────────────────────────────────────────────────
//
// These are last-resort guards. Sentry.captureException is called here so
// fatal crashes that bypass the errorHandler middleware are still reported.

process.on('uncaughtException', (error) => {
  logger.error('[Process] Uncaught exception — exiting for safety:', error)
  Sentry.captureException(error, { tags: { type: 'uncaughtException' } })
  // Best-effort flush — process will exit either way
  Sentry.flush(2_000).finally(() => process.exit(1))
})

process.on('unhandledRejection', (reason) => {
  logger.error(
    '[Process] Unhandled promise rejection — exiting for safety:',
    reason
  )
  Sentry.captureException(
    reason instanceof Error ? reason : new Error(String(reason)),
    {
      tags: { type: 'unhandledRejection' },
    }
  )
  Sentry.flush(2_000).finally(() => process.exit(1))
})

if (require.main === module) {
  main().catch((error) => {
    logger.error('[Startup] Unexpected fatal error:', error)
    Sentry.captureException(error, { tags: { phase: 'main' } })
    Sentry.flush(2_000).finally(() => process.exit(1))
  })
}

export default app
export { serviceStatus, allServicesReady }
