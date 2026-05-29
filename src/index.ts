import { type Server } from 'node:http'
import express from 'express'
import helmet from 'helmet'
import { config } from './config/env'
import { errorHandler } from './middleware/errorHandler'
import { requestLogger } from './middleware/logger'
import { rateLimiter, authRateLimiter, adminRateLimiter, internalRateLimiter, trustedIpBypass } from './middleware/rateLimiter'
import { logger } from './utils/logger'
import { startAgentLoop, stopAgentLoop } from './agent/loop'
import { connectDb } from './db'
import { scheduleSessionCleanup } from './jobs/sessionCleanup'
import { startEventListener, stopEventListener } from './stellar/events'
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
import { corsMiddleware, jsonBodyParser, payloadSizeErrorHandler, urlencodedBodyParser } from './middleware/corsandbody'

// ── Readiness state ───────────────────────────────────────────────────────────
//
// We track each critical background service independently so the readiness
// endpoint can report exactly what is (un)healthy.

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
const REQUEST_DRAIN_TIMEOUT_MS = 30000

function allServicesReady(): boolean {
  return Object.values(serviceStatus).every(s => s.ready)
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express()

// Trust proxy — required for correct client IP behind Nginx / Cloudflare / Heroku
app.set('trust proxy', 1)

// ── Security and parsing middleware ────────────────────────────────────────
app.use(helmet())

// CORS — must come before body parsers so pre-flight OPTIONS is handled
app.use(corsMiddleware)

// Body parsers with size limits (100 kb default, see config.security.bodySizeLimit)
app.use(jsonBodyParser)
app.use(urlencodedBodyParser)

// Logging + rate limiting
app.use(requestLogger)
// Trusted-IP / service-token bypass must run before any rate limiter
app.use(trustedIpBypass)
app.use(rateLimiter)

// ── Readiness / liveness probes ───────────────────────────────────────────────
//
// Liveness  — is the process running?  Always 200 once the process is up.
// Readiness — are background services healthy?  Used by load-balancers / K8s.

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

// ── Application routes ────────────────────────────────────────────────────────

app.use('/health', healthRouter)
app.use('/api/agent', internalRateLimiter, agentRouter)
app.use('/api/auth', authRateLimiter, authRouter)
app.use('/api/whatsapp', whatsappRouter)
app.use('/api/portfolio', portfolioRouter)
app.use('/api/transactions', transactionsRouter)
app.use('/api/protocols', protocolsRouter)
app.use('/api/deposit', depositRouter)
app.use('/api/withdraw', withdrawRouter)
app.use('/api/vault', vaultRouter)
app.use('/api/analytics', analyticsRouter)

app.use('/metrics', metricsRouter)
// Admin routes (protected, strictest rate limit)
app.use('/api/admin', adminRateLimiter, adminRouter)

// 413 handler — must be after body parsers, before generic error handler
app.use(payloadSizeErrorHandler)

// Generic error handler — must always be last
app.use(errorHandler)
// ── Graceful shutdown ────────────────────────────────────────────────────────
//
// On SIGTERM/SIGINT, we:
// 1. Mark as shutting down so readiness probe returns 503
// 2. Close the HTTP server (stops accepting new connections)
// 3. Wait up to REQUEST_DRAIN_TIMEOUT_MS for in-flight requests to complete
// 4. Stop event listener
// 5. Stop agent cron jobs
// 6. Disconnect Prisma
// 7. Exit cleanly

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`[Shutdown] Received ${signal}, initiating graceful shutdown...`)
  isShuttingDown = true

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
      // Importing here to avoid circular dependency
      const db = await import('./db').then(m => m.default)
      await db.$disconnect()

      logger.info('[Shutdown] ✓ All services stopped gracefully')
      process.exit(0)
    } catch (error) {
      logger.error('[Shutdown] Error during graceful shutdown:', {
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    }
  })

  // Force shutdown after timeout
  setTimeout(() => {
    logger.error('[Shutdown] Timeout reached, forcing shutdown...')
    process.exit(1)
  }, REQUEST_DRAIN_TIMEOUT_MS)
}

// ── Startup sequence ──────────────────────────────────────────────────────────
//
// The HTTP server does NOT start accepting connections until every critical
// service initialises successfully.  If any service fails, we log clearly
// and exit with a nonzero code so process supervisors / K8s restart us.

async function initServices(): Promise<void> {
  // 0. Validate production configuration
  if (config.nodeEnv === 'production') {
    const adminToken = process.env.ADMIN_API_TOKEN
    if (!adminToken || adminToken.length < 8) {
      const msg = 'ADMIN_API_TOKEN must be set to a strong value in production'
      logger.error('[Startup] Configuration validation failed — cannot continue', { error: msg })
      throw new Error(msg)
    }
    logger.info('[Startup] Admin API token configured ✓')
  }

  // 1. Database
  try {
    await connectDb()
    serviceStatus.database = { ready: true }
    logger.info('[Startup] Database connected ✓')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    serviceStatus.database = { ready: false, error: msg }
    logger.error('[Startup] Database connection failed — cannot continue', { error: msg })
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
    logger.error('[Startup] Event listener failed to start — cannot continue', { error: msg })
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
    logger.error('[Startup] Agent loop failed to start — cannot continue', { error: msg })
    throw new Error(`AgentLoop: ${msg}`)
  }
}

async function main(): Promise<void> {
  logger.info(`[Startup] NeuroWealth backend initialising`)
  logger.info(`[Startup] NODE_ENV=${config.nodeEnv}  network=${config.stellar.network}  port=${config.port}`)

  // Initialise all services BEFORE opening the HTTP port.
  // Any failure here exits the process — the server never starts.
  try {
    await initServices()
  } catch (initError) {
    logger.error('[Startup] One or more critical services failed to initialise:')
    logger.error(
      Object.entries(serviceStatus)
        .filter(([, s]) => !s.ready)
        .map(([name, s]) => `  ✗ ${name}: ${s.error ?? 'unknown error'}`)
        .join('\n')
    )
    process.exit(1)
  }

  // All services healthy — now accept traffic
  httpServer = app.listen(config.port, () => {
    logger.info(`[Startup] HTTP server listening on port ${config.port} ✓`)
    logger.info('[Startup] All systems operational — ready to serve requests')
  })

  // Register graceful shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  // Non-critical jobs start after the server is up
  scheduleSessionCleanup()
}

// ── Process-level error guards ────────────────────────────────────────────────

process.on('uncaughtException', (error) => {
  logger.error('[Process] Uncaught exception — exiting for safety:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('[Process] Unhandled promise rejection — exiting for safety:', reason)
  process.exit(1)
})

if (require.main === module) {
  main().catch((error) => {
    logger.error('[Startup] Unexpected fatal error:', error)
    process.exit(1)
  })
}

export default app
export { serviceStatus, allServicesReady }