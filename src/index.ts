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
import {
  errorResponseMiddleware,
  notFoundHandler,
} from './middleware/errorResponse'
import { requestLogger } from './middleware/logger'
import { requestTimeoutMiddleware } from './middleware/requestTimeout'
import {
  authRateLimiter,
  adminRateLimiter,
  internalRateLimiter,
  webhookRateLimiter,
  trustedIpBypass,
} from './middleware/rateLimiter'
import { APP_LEVEL_LIMITERS } from './middleware/rateLimiterChain'
import {
  configureTrustProxy,
  securityHeaders,
  permissionsPolicy,
} from './middleware/security'
import {
  featureFlagMiddleware,
  emergencyMaintenanceGuard,
} from './middleware/featureFlags'
import { featureFlagManager } from './config/featureFlags'
import { logger } from './utils/logger'
import { startAgentLoop, stopAgentLoop } from './agent/loop'
import { connectDb } from './db'
import { scheduleSessionCleanup } from './jobs/sessionCleanup'
import { scheduleDataRetention } from './jobs/dataRetention'
import { schedulePoolMetrics } from './jobs/poolMetrics'
import { scheduleFiatReconciliation } from './jobs/fiatReconciliation'
import { scheduleReferralPayout } from './jobs/referralPayout'
import { scheduleRecurringDeposits } from './jobs/recurringDeposits'
import { scheduleRecurringWithdrawals } from './jobs/recurringWithdrawals'
import { scheduleAlertRules } from './jobs/alertRules'
import { scheduleStrategyMetrics } from './jobs/strategyMetrics'
import { scheduleAllocationSuggestions } from './jobs/allocationSuggestions'
import { scheduleAttribution } from './jobs/attribution'
import { scheduleOutboxDispatcher } from './outbox/dispatcher'
import { startFeeOracle, stopFeeOracle } from './stellar/feeOracle'
import { scheduleProtocolRiskScoring } from './jobs/protocolRiskScoring'
import { scheduleSupportTicketSla } from './jobs/supportTicketSla'
import { scheduleRiskMetadataStaleness } from './jobs/riskMetadataStaleness'
import { schedulePortfolioRiskJob } from './jobs/portfolioRisk'
import { scheduleApprovalExpiry } from './jobs/approvalExpiry'
import { scheduleReserveReconciliation } from './jobs/reserveReconciliation'
import { scheduleMessageDeliverySweep } from './jobs/messageDeliverySweep'
import { scheduleSignerRotation } from './jobs/signerRotation'
import { scheduleLoanAccrual } from './jobs/loanAccrual'
import { scheduleLoanLiquidationMonitor } from './jobs/loanLiquidationMonitor'
import { scheduleLinkedExternalWalletSync } from './jobs/linkedExternalWalletSync'
import { startEventListener, stopEventListener } from './stellar/events'
import { startEventBridge, stopEventBridge } from './events/bridge'
import { attachWebSocketServer, closeWebSocketServer } from './ws/server'
import {
  startCacheInvalidationSubscriber,
  stopCacheInvalidationSubscriber,
} from './utils/user-cache-invalidation'
import { validateStellarNetworkReady } from './config/readiness'
import { API_ROUTES, EXTRA_MOUNTS } from './routes/registry'
import {
  corsMiddleware,
  jsonBodyParser,
  payloadSizeErrorHandler,
  urlencodedBodyParser,
  createContentTypeRestrictionMiddleware,
  validateCorsConfig,
} from './middleware/corsandbody'
import { setSpanUser } from './telemetry/spans'
import { scheduleOutboundNotifications } from './services/outboundNotifications'

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
let recurringDepositsHandle: NodeJS.Timeout | null = null
let recurringWithdrawalsHandle: NodeJS.Timeout | null = null
let alertRulesHandle: NodeJS.Timeout | null = null
let strategyMetricsHandle: NodeJS.Timeout | null = null
let allocationSuggestionsHandle: NodeJS.Timeout | null = null
let protocolRiskScoringHandle: NodeJS.Timeout | null = null
let supportTicketSlaHandle: NodeJS.Timeout | null = null
let riskMetadataStalenessHandle: NodeJS.Timeout | null = null
let attributionHandle: NodeJS.Timeout | null = null
let outboxDispatcherHandle: NodeJS.Timeout | null = null
let portfolioRiskJobHandle: NodeJS.Timeout | null = null
let approvalExpiryHandle: NodeJS.Timeout | null = null
let reserveReconciliationHandle: NodeJS.Timeout | null = null
let messageDeliverySweepHandle: NodeJS.Timeout | null = null
let signerRotationHandle: NodeJS.Timeout | null = null
let outboundNotificationsHandle: NodeJS.Timeout | null = null
let linkedExternalWalletSyncHandle: NodeJS.Timeout | null = null
let loanAccrualHandle: NodeJS.Timeout | null = null
let loanLiquidationHandle: NodeJS.Timeout | null = null

function allServicesReady(): boolean {
  return Object.values(serviceStatus).every((s) => s.ready)
}

// ── Configuration validation ──────────────────────────────────────────────────

// A production or staging deployment that cannot enforce a CORS allowlist must
// not start: every browser request would 403, and shipping that as a
// half-working service is worse than failing loudly at boot (#471).
try {
  validateCorsConfig()
} catch (error) {
  logger.error(
    `[CORS] Fatal startup error: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
  process.exit(1)
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express()

configureTrustProxy(app)

// ── Security and parsing middleware ───────────────────────────────────────────

app.disable('x-powered-by')
// Correlation ID — must run first so every response, including early
// rejections from CORS / body parsing / rate limiting, carries X-Request-ID.
app.use(correlationIdMiddleware)
// Standard error envelope — wraps res.json so every later 4xx/5xx response
// (including CORS, body parsing, auth and rate limiting) shares one shape.
app.use(errorResponseMiddleware)
app.use(securityHeaders())
app.use(permissionsPolicy())
app.use(corsMiddleware)
app.use(
  createContentTypeRestrictionMiddleware({
    excludedPaths: [
      '/whatsapp/webhook',
      '/api/v1/fiat/webhook',
      '/api/fiat/webhook',
    ],
  })
)
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
app.use(featureFlagMiddleware)
app.use(trustedIpBypass)
// The app-wide rate-limit chain: the flat global budget, then the identity
// tier. Both apply to every request, so no route is ever unlimited. Kept in
// src/middleware/rateLimiterChain.ts so the tier-matrix CI check can assert
// that claim against the real chain.
app.use(...APP_LEVEL_LIMITERS)
app.use(requestTimeoutMiddleware)
app.use(emergencyMaintenanceGuard)

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

// Unversioned routes are supported until a fixed, announced date. Pinning the
// date (instead of recomputing it on every boot) means a redeploy can never
// silently extend the lifetime of a deprecated alias.
const DEFAULT_UNVERSIONED_SUNSET = 'Sat, 01 May 2027 00:00:00 GMT'
function resolveUnversionedSunset(): string {
  const configured = process.env.API_LEGACY_SUNSET?.trim()
  if (!configured) return DEFAULT_UNVERSIONED_SUNSET
  const parsed = new Date(configured)
  return Number.isNaN(parsed.getTime())
    ? DEFAULT_UNVERSIONED_SUNSET
    : parsed.toUTCString()
}
const UNVERSIONED_SUNSET = resolveUnversionedSunset()

// ── OpenAPI / Swagger UI ──────────────────────────────────────────────────────

let swaggerSpec: Record<string, unknown> | null = null
const specPath = path.join(__dirname, 'docs', 'openapi.yaml')

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

const apiRoutes: ApiRoute[] = API_ROUTES

// ── Application routes ────────────────────────────────────────────────────────

// Operational endpoints and the pre-version paths (health, metrics, the legacy
// webhooks surface). Declared in src/routes/registry.ts so the tier matrix
// can describe every route the server serves, not just the versioned ones.
for (const mount of EXTRA_MOUNTS) {
  app.use(mount.path, ...mount.handlers)
}

// Primary, versioned mounts: /api/v1/*
for (const route of apiRoutes) {
  app.use(`/api/v1/${route.path}`, ...route.handlers)
}

// Legacy unversioned aliases: /api/* (deprecated, still functional)
for (const route of apiRoutes) {
  app.use(`/api/${route.path}`, deprecatedApiWarning, ...route.handlers)
}

// 404 for unmatched routes — after all routers, before the error handlers
app.use(notFoundHandler)

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

  if (outboundNotificationsHandle) {
    clearInterval(outboundNotificationsHandle)
    outboundNotificationsHandle = null
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

  if (recurringDepositsHandle) {
    clearInterval(recurringDepositsHandle)
    recurringDepositsHandle = null
    logger.info('[Shutdown] Recurring deposits timer cleared')
  }
  if (recurringWithdrawalsHandle) {
    clearInterval(recurringWithdrawalsHandle)
    recurringWithdrawalsHandle = null
  }

  if (alertRulesHandle) {
    clearInterval(alertRulesHandle)
    alertRulesHandle = null
    logger.info('[Shutdown] Alert rules timer cleared')
  }

  if (strategyMetricsHandle) {
    clearInterval(strategyMetricsHandle)
    strategyMetricsHandle = null
    logger.info('[Shutdown] Strategy metrics timer cleared')
  }

  if (supportTicketSlaHandle) {
    clearInterval(supportTicketSlaHandle)
    supportTicketSlaHandle = null
  }

  if (riskMetadataStalenessHandle) {
    clearInterval(riskMetadataStalenessHandle)
    riskMetadataStalenessHandle = null
  }

  if (protocolRiskScoringHandle) {
    clearInterval(protocolRiskScoringHandle)
    protocolRiskScoringHandle = null
    logger.info('[Shutdown] Protocol risk scoring timer cleared')
  }

  if (allocationSuggestionsHandle) {
    clearInterval(allocationSuggestionsHandle)
    allocationSuggestionsHandle = null
    logger.info('[Shutdown] Allocation suggestions timer cleared')
  }

  if (attributionHandle) {
    clearInterval(attributionHandle)
    attributionHandle = null
    logger.info('[Shutdown] Performance attribution timer cleared')
  }

  if (outboxDispatcherHandle) {
    clearInterval(outboxDispatcherHandle)
    outboxDispatcherHandle = null
    logger.info('[Shutdown] Outbox dispatcher timer cleared')
  }

  if (portfolioRiskJobHandle) {
    clearInterval(portfolioRiskJobHandle)
    portfolioRiskJobHandle = null
    logger.info('[Shutdown] Portfolio risk job timer cleared')
  }

  if (approvalExpiryHandle) {
    clearInterval(approvalExpiryHandle)
    approvalExpiryHandle = null
    logger.info('[Shutdown] Approval expiry sweep timer cleared')
  }

  if (reserveReconciliationHandle) {
    clearInterval(reserveReconciliationHandle)
    reserveReconciliationHandle = null
    logger.info('[Shutdown] Reserve reconciliation timer cleared')
  }

  if (messageDeliverySweepHandle) {
    clearInterval(messageDeliverySweepHandle)
    messageDeliverySweepHandle = null
    logger.info('[Shutdown] Message delivery sweep timer cleared')
  }

  if (signerRotationHandle) {
    clearInterval(signerRotationHandle)
    signerRotationHandle = null
    logger.info('[Shutdown] Signer rotation timer cleared')
  }

  if (linkedExternalWalletSyncHandle) {
    clearInterval(linkedExternalWalletSyncHandle)
    linkedExternalWalletSyncHandle = null
    logger.info('[Shutdown] External wallet sync timer cleared')
  }

  if (loanAccrualHandle) {
    clearInterval(loanAccrualHandle)
    loanAccrualHandle = null
    logger.info('[Shutdown] Loan accrual timer cleared')
  }

  if (loanLiquidationHandle) {
    clearInterval(loanLiquidationHandle)
    loanLiquidationHandle = null
    logger.info('[Shutdown] Loan liquidation monitor cleared')
  }

  try {
    stopFeeOracle()
    logger.info('[Shutdown] Fee oracle stopped')
  } catch {}

  if (!httpServer) {
    logger.warn('[Shutdown] No HTTP server to close')
    process.exit(0)
  }

  // #316: WebSocket sockets must drain BEFORE httpServer.close(). An open
  // WebSocket is a live HTTP connection, so closing the HTTP server first would
  // simply block on them until the grace period expired and then cut them
  // without warning. Draining first gives each client a `draining` frame
  // carrying the seq to resume after, so a rolling deploy costs a reconnect
  // rather than a REST snapshot. Awaited — connection cleanup is not optional.
  logger.info('[Shutdown] Draining WebSocket connections...')
  await closeWebSocketServer()
  await stopEventBridge()
  await stopCacheInvalidationSubscriber()

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
  const { validateSecretCredentials } = await import('./config/secrets')
  const secretErrors = validateSecretCredentials()
  if (secretErrors.length) {
    throw new Error(
      `[Startup] Secret validation failed: ${secretErrors.join('; ')}`
    )
  }

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

  // 0. Validate WebAuthn configuration in production
  if (config.nodeEnv === 'production' || config.nodeEnv === 'staging') {
    const { webAuthnConfig } = await import('./services/webauthn.service')
    try {
      webAuthnConfig()
      logger.info('[Startup] WebAuthn configuration validated ✓')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(
        '[Startup] WebAuthn configuration validation failed — cannot continue',
        { error: msg }
      )
      throw new Error(`WebAuthn: ${msg}`)
    }
  }

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

  // 4. Fee oracle (#342) — best-effort, never blocks startup
  try {
    await startFeeOracle()
    logger.info('[Startup] Fee oracle started ✓')
  } catch (error) {
    logger.error(
      '[Startup] Fee oracle failed to start — continuing with defaults',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    )
  }

  // 5. Feature Flags Redis Sync (#494) — best-effort, never blocks startup
  try {
    await featureFlagManager.syncFromRedis()
    logger.info('[Startup] Feature flag Redis sync initialized ✓')
  } catch (error) {
    logger.warn(
      '[Startup] Feature flag Redis sync failed — continuing with local configuration',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    )
  }

  // 6. Cache invalidation subscriber (#611) — best-effort, never blocks startup
  try {
    startCacheInvalidationSubscriber()
    logger.info('[Startup] Cache invalidation subscriber initialized ✓')
  } catch (error) {
    logger.warn(
      '[Startup] Cache invalidation subscriber failed — continuing with pod-local invalidation only',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    )
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

  // #316: authenticated real-time stream. Attached to the same HTTP server, so
  // it inherits the TLS termination, proxy configuration, and port the REST
  // surface already has. Started after listen() because it hooks the server's
  // 'upgrade' event, and the bridge is started alongside it so cross-pod
  // envelopes have somewhere to land the moment a socket connects.
  attachWebSocketServer(httpServer)
  await startEventBridge().catch((error) => {
    // A bridge failure degrades multi-pod delivery to pod-local delivery; it is
    // not a reason to refuse to serve traffic. Clients close the resulting gap
    // with `resume afterSeq`.
    logger.error(
      '[Startup] Event bridge failed to start — continuing with pod-local delivery only',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    )
  })

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  sessionCleanupHandle = scheduleSessionCleanup()
  dataRetentionHandle = scheduleDataRetention()
  poolMetricsHandle = schedulePoolMetrics()
  fiatReconciliationHandle = scheduleFiatReconciliation()
  referralPayoutHandle = scheduleReferralPayout()
  recurringDepositsHandle = scheduleRecurringDeposits()
  recurringWithdrawalsHandle = scheduleRecurringWithdrawals()
  alertRulesHandle = scheduleAlertRules()
  strategyMetricsHandle = scheduleStrategyMetrics()
  // Ordered before the suggestion job so the first suggestion run sees freshly
  // scored protocols rather than whatever was last left in the table.
  protocolRiskScoringHandle = scheduleProtocolRiskScoring()
  supportTicketSlaHandle = scheduleSupportTicketSla()
  riskMetadataStalenessHandle = scheduleRiskMetadataStaleness()
  allocationSuggestionsHandle = scheduleAllocationSuggestions()
  attributionHandle = scheduleAttribution()
  portfolioRiskJobHandle = schedulePortfolioRiskJob()
  approvalExpiryHandle = scheduleApprovalExpiry()
  reserveReconciliationHandle = scheduleReserveReconciliation()
  messageDeliverySweepHandle = scheduleMessageDeliverySweep()
  signerRotationHandle = scheduleSignerRotation()
  outboundNotificationsHandle = scheduleOutboundNotifications()
  linkedExternalWalletSyncHandle = scheduleLinkedExternalWalletSync()
  // #532 — accrual first, then the monitor: the monitor values loans, and it
  // must not value them on interest the accrual job has not yet recorded.
  loanAccrualHandle = scheduleLoanAccrual()
  loanLiquidationHandle = scheduleLoanLiquidationMonitor()
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
