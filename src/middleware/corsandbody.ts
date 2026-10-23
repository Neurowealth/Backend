/**
 * CORS + body-size middleware
 *
 * Origin policy lives in `src/config/cors.ts` (#471). In production *and*
 * staging, every request whose `Origin` is not on the allowlist is rejected with
 * 403, and a wildcard allowlist is refused at startup. Only `development` and
 * `test` permit arbitrary origins.
 *
 * Body size limits (default 100 kb) guard against large-payload DoS.
 * Both limits are configurable via environment variables.
 */

import { Request, Response, NextFunction } from 'express'
import cors, { CorsOptions } from 'cors'
import express from 'express'
import { config } from '../config/env'
import {
  buildOriginPolicy,
  describeRejection,
  evaluateOrigin,
  type CorsOriginPolicy,
} from '../config/cors'
import { logger } from '../utils/logger'
import { recordRejectedRequest } from '../utils/metrics'

// ── CORS ─────────────────────────────────────────────────────────────────────

/**
 * Headers a browser client may send. This list must cover every request header
 * the API actually reads, or a legitimate cross-origin request fails preflight.
 * Sources: idempotency keys, inbound webhook signature headers, service tokens
 * and the stream-resume header.
 */
const ALLOWED_REQUEST_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'Last-Event-ID',
  'X-Admin-Token',
  'X-Correlation-ID',
  'X-Internal-Token',
  'X-Request-ID',
  'X-Signature',
  'X-Telegram-Bot-Api-Secret-Token',
  'X-Twilio-Signature',
]

/** Response headers a browser client is allowed to read. */
const EXPOSED_RESPONSE_HEADERS = [
  'RateLimit-Limit',
  'RateLimit-Policy',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
  'X-API-Version',
  'X-Correlation-ID',
  'X-Request-ID',
]

/**
 * Build the origin policy from the process environment. The environment is
 * fixed for the lifetime of the process, so callers cache the result; it is
 * exported un-cached so tests can build a policy per environment.
 */
export function resolveCorsOriginPolicy(): CorsOriginPolicy {
  return buildOriginPolicy({
    raw: process.env.CORS_ORIGINS ?? process.env.ALLOWED_ORIGINS,
    environment: config.nodeEnv,
    requireOrigin: process.env.CORS_REQUIRE_ORIGIN
      ? process.env.CORS_REQUIRE_ORIGIN !== 'false'
      : undefined,
  })
}

const originPolicy = resolveCorsOriginPolicy()

/** The active origin policy. Exposed for tests and the startup log. */
export function getCorsOriginPolicy(): CorsOriginPolicy {
  return originPolicy
}

function buildCorsOptions(policy: CorsOriginPolicy): CorsOptions {
  return {
    origin(requestOrigin, callback) {
      const decision = evaluateOrigin(policy, requestOrigin)

      if (decision.allowed) {
        callback(null, true)
        return
      }

      if (decision.reason === 'not-allowlisted') {
        logger.warn(`[CORS] Rejected disallowed origin: ${requestOrigin}`)
      } else if (decision.reason === 'no-origin-header') {
        logger.warn('[CORS] Rejecting request with no Origin header')
      } else {
        // A misconfiguration means this deployment's allowlist does not work at
        // all. Make it loud and counted, not just logged.
        logger.error(`[CORS] ${describeRejection(decision)}`)
        recordRejectedRequest('cors_misconfiguration')
      }

      callback(new Error(describeRejection(decision)))
    },

    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
    credentials: true,
    // Preflight cache: 2 hours where the allowlist is enforced, no cache in dev.
    maxAge: policy.strict ? 7200 : 0,
    optionsSuccessStatus: 204,
  }
}

/**
 * Build CORS middleware for an explicit policy. `corsMiddleware` uses the
 * process policy; tests use this to exercise each environment in isolation.
 */
export function createCorsMiddleware(
  policy: CorsOriginPolicy
): (req: Request, res: Response, next: NextFunction) => void {
  // Built once per policy, not per request — the options object is immutable.
  const handler = cors(buildCorsOptions(policy))

  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (err) => {
      if (err) {
        recordRejectedRequest('cors_origin')
        res.status(403).json({
          success: false,
          error: 'Forbidden',
          reason: err.message,
        })
        return
      }
      next()
    })
  }
}

// Built once, not per request — `config` is frozen at import, so the options
// object is identical for every request in the process.
const corsHandler = createCorsMiddleware(originPolicy)

/**
 * Express middleware that handles CORS and converts CORS errors into
 * proper 403 JSON responses instead of letting them bubble to
 * the generic error handler.
 */
export const corsMiddleware = corsHandler

/**
 * Startup CORS validation. Fails fast — before the server accepts traffic — when
 * a production or staging deployment cannot enforce an allowlist.
 *
 * Called by both entrypoints: `src/index.ts` (the deployed server) and
 * `src/app.ts`.
 */
export function validateCorsConfig(
  policy: CorsOriginPolicy = originPolicy
): void {
  if (policy.invalidEntries.length > 0) {
    throw new Error(
      'CORS allowlist contains entries that are not valid origins: ' +
        `${policy.invalidEntries.join(', ')}. ` +
        'Each entry must be an absolute origin such as https://app.example.com, ' +
        'or a single-label subdomain wildcard such as https://*.example.com.'
    )
  }

  if (policy.wildcardRejected) {
    throw new Error(
      `CORS_ORIGINS='*' is not permitted when NODE_ENV=${config.nodeEnv}. ` +
        'A wildcard allowlist combined with credentialed requests lets any ' +
        'website read authenticated responses. List the exact origins instead, ' +
        'or set NODE_ENV=development on local machines.'
    )
  }

  if (
    policy.strict &&
    policy.origins.length === 0 &&
    policy.patterns.length === 0
  ) {
    throw new Error(
      `CORS allowlist must be set and non-empty when NODE_ENV=${config.nodeEnv}. ` +
        'Set CORS_ORIGINS to a comma-separated list of permitted origins, e.g. ' +
        'CORS_ORIGINS=https://app.example.com,https://admin.example.com'
    )
  }
}

/**
 * Legacy CORS setup helper, retained for the src/app.ts entrypoint.
 * The src/index.ts entrypoint wires corsMiddleware directly instead.
 */
export function setupCors(app: express.Application): void {
  validateCorsConfig()
  app.use(corsMiddleware)
}

// ── Content-type restrictions ────────────────────────────────────────────────────

const DISALLOWED_CONTENT_TYPES = [
  'multipart/form-data',
  'application/x-www-form-urlencoded',
]

/**
 * Middleware to reject disallowed content types (multipart/form-data, application/x-www-form-urlencoded).
 * Returns 415 Unsupported Media Type for disallowed content types.
 * Can be skipped for specific paths (e.g., webhooks) or per-route by setting req.allowUrlEncoded = true.
 */
export function createContentTypeRestrictionMiddleware(options?: {
  excludedPaths?: string[]
}) {
  const excludedPaths = options?.excludedPaths ?? []

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip if route has opted out of content-type restrictions
    if ((req as any).allowUrlEncoded) {
      return next()
    }

    // Skip if request path is in the exclusion list
    const path = req.path || req.url
    if (excludedPaths.some((excluded) => path.startsWith(excluded))) {
      return next()
    }

    const contentType = req.headers['content-type']
    if (!contentType) {
      return next()
    }

    // Check if content type matches any disallowed type
    for (const disallowed of DISALLOWED_CONTENT_TYPES) {
      if (contentType.toLowerCase().includes(disallowed)) {
        logger.warn(
          `[Content-Type] Rejecting disallowed content type: ${contentType}`
        )
        recordRejectedRequest('content_type')
        res.status(415).json({
          success: false,
          error: 'Unsupported Media Type',
          reason: `Content type "${disallowed}" is not allowed.`,
        })
        return
      }
    }

    next()
  }
}

/**
 * Default content-type restriction middleware instance (no excluded paths).
 * For custom path exclusions, use createContentTypeRestrictionMiddleware instead.
 */
export function contentTypeRestrictionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const middleware = createContentTypeRestrictionMiddleware()
  middleware(req, res, next)
}

// ── Body size limits ──────────────────────────────────────────────────────────

const { bodySizeLimit } = config.security

/**
 * JSON body parser capped at `bodySizeLimit` (default 64 kb).
 * Requests exceeding the limit are rejected with 413 automatically by Express.
 */
export const jsonBodyParser = express.json({ limit: bodySizeLimit })

/**
 * URL-encoded body parser capped at `bodySizeLimit`.
 * `extended: false` uses the built-in querystring library — no prototype-pollution risk.
 * Note: This parser is still available for routes that need it (e.g., Twilio webhooks),
 * but the contentTypeRestrictionMiddleware will reject application/x-www-form-urlencoded
 * unless the route opts out by setting req.allowUrlEncoded = true.
 */
export const urlencodedBodyParser = express.urlencoded({
  limit: bodySizeLimit,
  extended: false,
})

/**
 * Custom 413 handler — placed after the body parsers in the middleware chain.
 * Express emits a SyntaxError / PayloadTooLargeError for oversized bodies;
 * this converts those into a consistent JSON response.
 */
export function payloadSizeErrorHandler(
  err: any,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err.type === 'entity.too.large') {
    recordRejectedRequest('oversized')
    res.status(413).json({
      success: false,
      error: 'Payload Too Large',
      reason: `Request body exceeds the ${bodySizeLimit} limit.`,
    })
    return
  }
  next(err)
}

/**
 * Middleware to allow per-route override of body size limit.
 * Usage: app.post('/admin/bulk', allowBodySizeOverride('1mb'), handler)
 */
export function allowBodySizeOverride(limit: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Store the override limit on the request for the body parser to use
    ;(req as any).bodySizeLimitOverride = limit
    next()
  }
}
