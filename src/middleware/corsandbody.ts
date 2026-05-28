/**
 * CORS + body-size middleware
 *
 * In production every request whose `Origin` header is not in the ALLOWED_ORIGINS
 * allowlist is rejected with 403.  In development/staging any origin is permitted
 * so local tooling (Postman, front-end dev servers, etc.) works without extra config.
 *
 * Body size limits (default 100 kb) guard against large-payload DoS.
 * Both limits are configurable via environment variables.
 */

import { Request, Response, NextFunction } from 'express'
import cors, { CorsOptions } from 'cors'
import express from 'express'
import { config } from '../config/env'
import { logger } from '../utils/logger'

// ── CORS ─────────────────────────────────────────────────────────────────────

function buildCorsOptions(): CorsOptions {
  const { allowedOrigins, } = config.security
  const isProduction = config.nodeEnv === 'production'

  return {
    origin(requestOrigin, callback) {
      // Non-browser requests (curl, server-to-server) have no Origin header.
      // Allow them in non-production; block in production unless explicitly listed.
      if (!requestOrigin) {
        if (isProduction) {
          logger.warn('[CORS] Rejecting request with no Origin header in production')
          callback(new Error('CORS: missing Origin header'))
        } else {
          callback(null, true)
        }
        return
      }

      // In development / staging allow everything — fast inner loop matters more than security.
      if (!isProduction) {
        callback(null, true)
        return
      }

      // Production: strict allowlist check
      if (allowedOrigins.length === 0) {
        // Misconfiguration guard — refuse all if allowlist is empty
        logger.error(
          '[CORS] ALLOWED_ORIGINS is empty in production. ' +
            'Set it to a comma-separated list of permitted origins.'
        )
        callback(new Error('CORS: server misconfiguration — no origins allowed'))
        return
      }

      if (allowedOrigins.includes(requestOrigin)) {
        callback(null, true)
      } else {
        logger.warn(`[CORS] Rejected disallowed origin: ${requestOrigin}`)
        callback(new Error(`CORS: origin "${requestOrigin}" is not allowed`))
      }
    },

    // Standard safe headers; expand as your API needs grow
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    credentials: true,
    // Pre-flight cache: 2 hours in production, no cache in dev
    maxAge: isProduction ? 7200 : 0,
    optionsSuccessStatus: 204,
  }
}

/**
 * Express middleware that handles CORS and converts CORS errors into
 * proper 403 JSON responses instead of letting them bubble to the
 * generic error handler.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  cors(buildCorsOptions())(req, res, (err) => {
    if (err) {
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

// ── Body size limits ──────────────────────────────────────────────────────────

const { bodySizeLimit } = config.security

/**
 * JSON body parser capped at `bodySizeLimit` (default 100 kb).
 * Requests exceeding the limit are rejected with 413 automatically by Express.
 */
export const jsonBodyParser = express.json({ limit: bodySizeLimit })

/**
 * URL-encoded body parser capped at `bodySizeLimit`.
 * `extended: false` uses the built-in querystring library — no prototype-pollution risk.
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
    res.status(413).json({
      success: false,
      error: 'Payload Too Large',
      reason: `Request body exceeds the ${bodySizeLimit} limit.`,
    })
    return
  }
  next(err)
}