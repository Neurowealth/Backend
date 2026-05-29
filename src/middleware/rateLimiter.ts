import { type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { config } from '../config/env'

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

// ── Rate limiters ──────────────────────────────────────────────────────────

/**
 * Global rate limiter — applied to every route.
 * Defaults: 100 req / 15 min (env: RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS).
 */
export const rateLimiter = rateLimit({
  windowMs: config.security.rateLimit.windowMs,
  max: config.security.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrusted,
  message: {
    error: 'Too many requests. Please try again later.',
  },
})

/**
 * Auth rate limiter — stricter, to resist credential stuffing & brute force.
 * Defaults: 20 req / 15 min (env: AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW_MS).
 */
export const authRateLimiter = rateLimit({
  windowMs: config.security.authRateLimit.windowMs,
  max: config.security.authRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrusted,
  message: {
    error: 'Too many authentication attempts. Please try again in 15 minutes.',
  },
})

/**
 * Admin rate limiter — tightest limits for management/sensitive operations.
 * Defaults: 10 req / 15 min (env: ADMIN_RATE_LIMIT_MAX / ADMIN_RATE_LIMIT_WINDOW_MS).
 */
export const adminRateLimiter = rateLimit({
  windowMs: config.security.adminRateLimit.windowMs,
  max: config.security.adminRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrusted,
  message: {
    error: 'Too many requests to the admin API. Please try again later.',
  },
})

/**
 * Internal / agent rate limiter — higher throughput for service-to-service calls.
 * Defaults: 500 req / 1 min (env: INTERNAL_RATE_LIMIT_MAX / INTERNAL_RATE_LIMIT_WINDOW_MS).
 */
export const internalRateLimiter = rateLimit({
  windowMs: config.security.internalRateLimit.windowMs,
  max: config.security.internalRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrusted,
  message: {
    error: 'Too many requests from this service. Please slow down.',
  },
})