import { type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { config } from '../config/env'
import { recordRateLimitHit } from '../utils/metrics'
import { logger } from '../utils/logger'

// ── Trusted-IP / service-token bypass ─────────────────────────────────────

/**
 * Mark requests originating from trusted IPs or carrying the internal service
 * token as exempt.  Must be mounted **before** any rate-limiter middleware on
 * the routes that should honour the bypass.
 *
 * Trusted sources are configured via:
 *   TRUSTED_IPS            — comma-separated IPv4/IPv6 addresses
 *   INTERNAL_SERVICE_TOKEN — opaque token sent in the X-Internal-Token header
 */
export function trustedIpBypass(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? ''
  const token = req.headers['x-internal-token']

  const ipTrusted =
    config.security.trustedIps.length > 0 && config.security.trustedIps.includes(ip)
  const tokenTrusted =
    config.security.internalServiceToken.length > 0 &&
    token === config.security.internalServiceToken

  if (ipTrusted || tokenTrusted) {
    res.locals['trusted'] = true
  }

  next()
}

/** Returns true when the request has already been marked as trusted. */
function isTrusted(req: Request): boolean {
  return req.res?.locals['trusted'] === true
}

/** K8s / load-balancer probes must not consume the global rate-limit budget. */
function isHealthProbe(req: Request): boolean {
  return (
    req.path === '/health/live' ||
    req.path === '/health/ready' ||
    req.path === '/health' ||
    req.path.startsWith('/health/')
  )
}

function skipUnlessLimited(req: Request): boolean {
  return isTrusted(req) || isHealthProbe(req)
}

/**
 * Extract the route group from the request path for metrics labeling.
 * Maps paths to meaningful groups (e.g., /api/auth/* -> auth, /api/admin/* -> admin).
 */
function getRouteGroup(path: string): string {
  const match = path.match(/^\/api\/(\w+)/)
  return match ? match[1] : 'general'
}

/**
 * Handler called when rate limit is exceeded. Sets Retry-After before responding.
 */
function handleRateLimitExceeded(
  req: any,
  res: any,
  options: { limiterType: string; windowMs: number }
): void {
  const routeGroup = getRouteGroup(req.path)
  recordRateLimitHit(routeGroup, options.limiterType)

  logger.warn('[RateLimit] Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    method: req.method,
    limiterType: options.limiterType,
  })

  const resetTime = req.rateLimit?.resetTime as Date | undefined
  const retryAfter = resetTime
    ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
    : Math.ceil(options.windowMs / 1000)

  res.setHeader('Retry-After', String(retryAfter))
  res.status(429).json({
    error: 'Too many requests. Please try again later.',
  })
}

// ── Rate limiter factory ───────────────────────────────────────────────────

export interface BuildRateLimiterOptions {
  windowMs: number
  max: number
  skip?: (req: Request) => boolean
  limiterType: string
  message?: string
}

/**
 * Creates a rate-limiting middleware with IETF-standard response headers:
 *   RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset  (draft-6, every response)
 *   RateLimit-Policy                                          (IETF draft, every response)
 *   Retry-After                                               (seconds until reset, 429 only)
 */
export function buildRateLimiter(
  opts: BuildRateLimiterOptions
): (req: Request, res: Response, next: NextFunction) => void {
  const policy = `${opts.max};w=${Math.ceil(opts.windowMs / 1000)}`

  const limiter = rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: opts.skip,
    message: { error: opts.message ?? 'Too many requests. Please try again later.' },
    handler: (req: any, res: any) =>
      handleRateLimitExceeded(req, res, {
        limiterType: opts.limiterType,
        windowMs: opts.windowMs,
      }),
  })

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('RateLimit-Policy', policy)
    limiter(req, res, next)
  }
}

// ── Rate limiters ──────────────────────────────────────────────────────────

/**
 * Global rate limiter — applied to every route.
 * Defaults: 100 req / 15 min (env: RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS).
 */
export const rateLimiter = buildRateLimiter({
  windowMs: config.security.rateLimit.windowMs,
  max: config.security.rateLimit.max,
  skip: skipUnlessLimited,
  limiterType: 'global',
})

/**
 * Auth rate limiter — stricter, to resist credential stuffing & brute force.
 * Defaults: 20 req / 15 min (env: AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW_MS).
 */
export const authRateLimiter = buildRateLimiter({
  windowMs: config.security.authRateLimit.windowMs,
  max: config.security.authRateLimit.max,
  skip: isTrusted,
  limiterType: 'auth',
  message: 'Too many authentication attempts. Please try again in 15 minutes.',
})

/**
 * Admin rate limiter — tightest limits for management/sensitive operations.
 * Defaults: 10 req / 15 min (env: ADMIN_RATE_LIMIT_MAX / ADMIN_RATE_LIMIT_WINDOW_MS).
 */
export const adminRateLimiter = buildRateLimiter({
  windowMs: config.security.adminRateLimit.windowMs,
  max: config.security.adminRateLimit.max,
  skip: isHealthProbe,
  limiterType: 'admin',
  message: 'Too many requests to the admin API. Please try again later.',
})

/**
 * Webhook rate limiter — applied to unauthenticated inbound webhooks.
 * Defaults: 30 req / 1 min (env: WEBHOOK_RATE_LIMIT_MAX / WEBHOOK_RATE_LIMIT_WINDOW_MS).
 */
export const webhookRateLimiter = buildRateLimiter({
  windowMs: config.security.webhookRateLimit.windowMs,
  max: config.security.webhookRateLimit.max,
  skip: isTrusted,
  limiterType: 'webhook',
  message: 'Too many webhook requests. Please try again later.',
})

/**
 * Internal / agent rate limiter — higher throughput for service-to-service calls.
 * Defaults: 500 req / 1 min (env: INTERNAL_RATE_LIMIT_MAX / INTERNAL_RATE_LIMIT_WINDOW_MS).
 */
export const internalRateLimiter = buildRateLimiter({
  windowMs: config.security.internalRateLimit.windowMs,
  max: config.security.internalRateLimit.max,
  skip: isTrusted,
  limiterType: 'internal',
  message: 'Too many requests from this service. Please slow down.',
})
