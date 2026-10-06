import { type Request, type Response, type NextFunction } from 'express'
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit'
import { config } from '../config/env'
import { recordRateLimitHit, updateRateLimitViolations } from '../utils/metrics'
import { logger } from '../utils/logger'
import db from '../db'
import crypto from 'node:crypto'

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
export function trustedIpBypass(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ip = req.ip ?? ''
  const token = req.headers['x-internal-token']

  const ipTrusted =
    config.security.trustedIps.length > 0 &&
    config.security.trustedIps.includes(ip)
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

// ── Principal identification (#473) ───────────────────────────────────────

/**
 * What the request is being rate limited *as*. This is the label that makes the
 * blocked-request metric actionable: a spike in `anonymous` means scraping or
 * credential stuffing, while a spike in `authenticated` means a malfunctioning
 * client or a compromised key — very different incidents, same 429.
 */
export type PrincipalType =
  'anonymous' | 'user' | 'api_key' | 'admin' | 'internal'

interface Principal {
  type: PrincipalType
  /** Stable bucket id. Scoped by `type` so two namespaces can never collide. */
  key: string
}

/**
 * Derive the identity a limit should be counted against, in order of
 * trustworthiness:
 *
 *   internal service token → the pod/service account
 *   admin API key          → the admin credential
 *   API key (nwk_…)        → the key id, so two keys behind one NAT are
 *                            separate buckets and one key cannot exhaust a
 *                            building's budget
 *   authenticated session  → the user id
 *   otherwise              → the client IP
 *
 * The most specific *proven* identity wins. Guessing "authenticated" from the
 * mere presence of an Authorization header would let an attacker mint unlimited
 * buckets by sending garbage bearer tokens, so only identities the auth
 * middleware has already verified are trusted.
 */
export function resolvePrincipal(req: Request): Principal {
  if (isTrusted(req)) {
    return { type: 'internal', key: `internal:${req.ip ?? 'unknown'}` }
  }

  const adminToken = req.header('X-Admin-Token')
  if (adminToken && process.env.ADMIN_API_TOKEN) {
    if (adminToken === process.env.ADMIN_API_TOKEN) {
      return { type: 'admin', key: 'admin:token' }
    }
  }

  const auth = req.header('Authorization')
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim()

    // API keys are self-describing: nwk_<keyId>_<secret>.
    if (token.startsWith('nwk_')) {
      const keyId = token.split('_')[1]
      if (keyId) return { type: 'api_key', key: `api_key:${keyId}` }
    }

    // Only a session the auth middleware has already resolved counts as a user.
    if (req.userId) {
      return { type: 'user', key: `user:${req.userId}` }
    }
  }

  return { type: 'anonymous', key: `ip:${req.ip ?? 'unknown'}` }
}

/**
 * Extract the route group from the request path for metrics labeling.
 * Maps paths to meaningful groups (e.g., /api/auth/* -> auth, /api/admin/* -> admin).
 */
function getRouteGroup(path: string): string {
  const match = path.match(/^\/api\/(?:v\d+\/)?(\w+)/)
  return match ? match[1] : 'general'
}

// ── Response headers ──────────────────────────────────────────────────────

/**
 * Emit the *effective* policy for this request.
 *
 * The previous implementation wrote a static `RateLimit-Policy` built from the
 * limiter's configured `max`. That is a lie whenever the limit is resolved per
 * request: an API key with `rateLimitPerMin: 5` was told it had 100, and a
 * client that reads the header to schedule its retries would keep hammering a
 * 5/min endpoint. `req.rateLimit` reflects the limit actually applied, so the
 * quota comes from it; the window is fixed per limiter and passed in.
 */
function applyPolicyHeader(
  req: Request,
  res: Response,
  fallback: { max: number; windowMs: number }
): void {
  const applied = (
    req as Request & {
      rateLimit?: { limit?: number }
    }
  ).rateLimit

  const limit = applied?.limit ?? fallback.max
  const seconds = Math.ceil(fallback.windowMs / 1000)

  // draft-7 syntax is "<quota>;w=<window>"; the legacy form used a bare
  // "<quota>" which browsers could not interpret as a policy at all.
  res.setHeader('RateLimit-Policy', `${limit};w=${seconds}`)
}

/**
 * Handler called when rate limit is exceeded. Sets Retry-After before responding.
 */
function handleRateLimitExceeded(
  req: Request & { rateLimit?: { resetTime?: Date; limit?: number } },
  res: Response,
  options: { limiterType: string; windowMs: number; max: number }
): void {
  const routeGroup = getRouteGroup(req.path)
  const principal = resolvePrincipal(req)

  recordRateLimitHit(routeGroup, options.limiterType, principal.type)

  // Keep a gauge of the last known blocked-pending count per group so an alert
  // can fire on "requests are being blocked right now" rather than only on
  // cumulative totals, which stay flat once traffic stops.
  updateRateLimitViolations(routeGroup, 1)

  logger.warn('[RateLimit] Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    method: req.method,
    limiterType: options.limiterType,
    principalType: principal.type,
  })

  const resetTime = req.rateLimit?.resetTime
  const retryAfter = resetTime
    ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
    : Math.ceil(options.windowMs / 1000)

  res.setHeader('Retry-After', String(retryAfter))
  // The policy header must agree with the 429 it accompanies, otherwise a
  // client retrying on RateLimit-Policy sees a different budget than the one
  // that just rejected it.
  res.setHeader(
    'RateLimit-Policy',
    `${req.rateLimit?.limit ?? options.max};w=${Math.ceil(options.windowMs / 1000)}`
  )
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
  /**
   * Count against the request's principal instead of its IP. On by default:
   * IP-only keying means a single user behind a NAT, or a server making many
   * calls with different API keys, is throttled by strangers, and one abusive
   * client can rotate IPs freely to escape the budget.
   */
  keyByPrincipal?: boolean
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
  const usePrincipal = opts.keyByPrincipal !== false

  /**
   * Per-API-key override. Kept as the `max` callback (not the key) so the
   * override is expressed as a quota on the key's own bucket.
   */
  const resolveMax = async (req: Request): Promise<number> => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/, '')
    if (!token?.startsWith('nwk_')) return opts.max
    const keyId = token.split('_')[1]
    const tokenPrefix =
      'sha256:' + crypto.createHash('sha256').update(token).digest('hex')
    const key = await (
      db as unknown as {
        userApiKey: {
          findFirst: (args: unknown) => Promise<{
            rateLimitPerMin: number | null
          } | null>
        }
      }
    ).userApiKey.findFirst({
      where: { id: keyId, tokenPrefix, revokedAt: null },
      select: { rateLimitPerMin: true },
    })
    return key?.rateLimitPerMin ?? opts.max
  }

  const limiter: RateLimitRequestHandler = rateLimit({
    windowMs: opts.windowMs,
    max: resolveMax,
    ...(usePrincipal && {
      keyGenerator: (req: Request) => resolvePrincipal(req).key,
    }),
    standardHeaders: true,
    legacyHeaders: false,
    skip: opts.skip,
    message: {
      error: opts.message ?? 'Too many requests. Please try again later.',
    },
    handler: (req: any, res: any) =>
      handleRateLimitExceeded(req, res, {
        limiterType: opts.limiterType,
        windowMs: opts.windowMs,
        max: opts.max,
      }),
  })

  return (req: Request, res: Response, next: NextFunction): void => {
    limiter(req, res, () => {
      applyPolicyHeader(req, res, { max: opts.max, windowMs: opts.windowMs })
      next()
    })
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
 * Identity-tiered limiter (#473) — the one that separates anonymous traffic
 * from authenticated traffic.
 *
 * Expressed as a single limiter with a per-request quota rather than two
 * chained limiters. Chaining them would be a double-count: whichever guard
 * "skips" first, both would have to inspect the same identity, and getting the
 * order wrong silently halves every budget. One limiter, one bucket per
 * principal, one quota chosen by who the caller proved itself to be.
 *
 * Quotas (env: ANONYMOUS_RATE_LIMIT_*, AUTHENTICATED_RATE_LIMIT_*):
 *   anonymous   — per IP, strict. No proven identity, so the budget is there to
 *                 slow enumeration and scraping.
 *   authenticated — per user or per API key, generous. Charging a signed-in
 *                 user the anonymous budget would push normal traffic onto the
 *                 login endpoint.
 */
export const tieredRateLimiter = (() => {
  const { windowMs, max: anonymousMax } = config.security.anonymousRateLimit
  const { max: authenticatedMax } = config.security.authenticatedRateLimit

  const limiter: RateLimitRequestHandler = rateLimit({
    windowMs,
    max: async (req: Request) => {
      // An API key's own allowance always wins over both defaults.
      const token = req.header('Authorization')?.replace(/^Bearer\s+/, '')
      if (token?.startsWith('nwk_')) {
        const keyId = token.split('_')[1]
        const tokenPrefix =
          'sha256:' + crypto.createHash('sha256').update(token).digest('hex')
        const key = await (
          db as unknown as {
            userApiKey: {
              findFirst: (args: unknown) => Promise<{
                rateLimitPerMin: number | null
              } | null>
            }
          }
        ).userApiKey.findFirst({
          where: { id: keyId, tokenPrefix, revokedAt: null },
          select: { rateLimitPerMin: true },
        })
        if (key?.rateLimitPerMin) return key.rateLimitPerMin
      }

      const principal = resolvePrincipal(req)
      return principal.type === 'anonymous' ? anonymousMax : authenticatedMax
    },
    keyGenerator: (req: Request) => resolvePrincipal(req).key,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isTrusted,
    message: { error: 'Too many requests. Please try again later.' },
    handler: (req: any, res: any) =>
      handleRateLimitExceeded(req, res, {
        limiterType: 'tiered',
        windowMs,
        max: anonymousMax,
      }),
  })

  return (req: Request, res: Response, next: NextFunction): void => {
    limiter(req, res, () => {
      applyPolicyHeader(req, res, {
        max: anonymousMax,
        windowMs: config.security.anonymousRateLimit.windowMs,
      })
      next()
    })
  }
})()

/**
 * Auth rate limiter — stricter, to resist credential stuffing & brute force.
 * Defaults: 20 req / 15 min (env: AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW_MS).
 *
 * IP-keyed on purpose (#473): credential stuffing is by definition made before
 * any identity is proven, so a per-user key would be meaningless here.
 */
export const authRateLimiter = buildRateLimiter({
  windowMs: config.security.authRateLimit.windowMs,
  max: config.security.authRateLimit.max,
  skip: isTrusted,
  limiterType: 'auth',
  keyByPrincipal: false,
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
  keyByPrincipal: false,
  message: 'Too many webhook requests. Please try again later.',
})

/**
 * Guardian recovery limiter (#535) — the PUBLIC recovery endpoints.
 * Defaults: 10 req / 15 min (env: RECOVERY_RATE_LIMIT_MAX / RECOVERY_RATE_LIMIT_WINDOW_MS).
 *
 * Applied only to the unauthenticated recovery endpoints, not to the whole
 * router. The reason is abuse rather than credential guessing: recovery tokens
 * are 256-bit random, so they cannot be brute-forced, but `POST /recovery/initiate`
 * is deliberately open to anyone and triggers real email to real guardians. Left
 * unthrottled it is an email-bombing and SMS-flooding primitive aimed at a
 * third party who never consented to be a guardian. Owner endpoints sit under the
 * caller's own session and are already limited by `authRateLimiter`.
 */
export const recoveryRateLimiter = buildRateLimiter({
  windowMs: config.security.recoveryRateLimit.windowMs,
  max: config.security.recoveryRateLimit.max,
  skip: isTrusted,
  limiterType: 'recovery',
  message:
    'Too many recovery requests. Please wait before trying again, and contact support if you are locked out.',
})

/**
 * Sensitive-operation limiter (#473) — money movement and credential changes.
 * Defaults: 10 req / 15 min (env: SENSITIVE_RATE_LIMIT_MAX / SENSITIVE_RATE_LIMIT_WINDOW_MS).
 *
 * Applied per-endpoint *in addition to* the route's normal limiter, so a burst
 * of withdrawals is stopped without also throttling the balance reads the user
 * needs to make the decision.
 */
export const sensitiveRateLimiter = buildRateLimiter({
  windowMs: config.security.sensitiveRateLimit.windowMs,
  max: config.security.sensitiveRateLimit.max,
  skip: isTrusted,
  limiterType: 'sensitive',
  message:
    'Too many sensitive operations. Please wait before retrying this action.',
})

/**
 * Optimizer rate limiter (#322) — for the CPU-bound allocation-suggestion
 * endpoint. Defaults: 5 req / 1 min (env: OPTIMIZER_RATE_LIMIT_MAX /
 * OPTIMIZER_RATE_LIMIT_WINDOW_MS).
 *
 * Applied PER ENDPOINT rather than through the `apiRoutes` handlers array. The
 * table convention is right for a resource whose routes are uniformly costly,
 * but /portfolio is mostly cheap reads that must not inherit a 5/min budget
 * because one POST on the same router is expensive. This is not the
 * double-application the warning in src/routes/admin.ts guards against — no
 * table-level limiter is applied to this route.
 */
export const optimizerRateLimiter = buildRateLimiter({
  windowMs: config.security.optimizerRateLimit.windowMs,
  max: config.security.optimizerRateLimit.max,
  skip: isTrusted,
  limiterType: 'optimizer',
  message:
    'Too many optimization requests. Portfolio optimization is compute-intensive; please try again shortly.',
})

/**
 * Strategy simulate rate limiter (#344) — for the CPU-bound what-if historical
 * replay. Defaults: 6 req / 1 min (env: SIMULATE_RATE_LIMIT_MAX /
 * SIMULATE_RATE_LIMIT_WINDOW_MS). Applied per-endpoint on the simulate route
 * only, mirroring the optimizer limiter's reasoning — the marketplace reads on
 * the same router must not inherit a tight budget.
 */
export const simulateRateLimiter = buildRateLimiter({
  windowMs: config.security.simulateRateLimit.windowMs,
  max: config.security.simulateRateLimit.max,
  skip: isTrusted,
  limiterType: 'simulate',
  message:
    'Too many simulation requests. Historical replay is compute-intensive; please try again shortly.',
})

/**
 * Internal / agent rate limiter — higher throughput for service-to-service calls.
 */
export const internalRateLimiter = buildRateLimiter({
  windowMs: config.security.internalRateLimit.windowMs,
  max: config.security.internalRateLimit.max,
  skip: isTrusted,
  limiterType: 'internal',
  keyByPrincipal: false,
  message: 'Too many requests from this service. Please slow down.',
})
