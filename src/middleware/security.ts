import { type Express, type Request, type Response, type NextFunction } from 'express'
import helmet from 'helmet'
import { config } from '../config/env'

/**
 * Apply Express `trust proxy` so `req.ip`, `req.protocol`, and rate-limit
 * keys reflect the real client when the app sits behind a reverse proxy.
 *
 * Configure via `TRUST_PROXY` (default: `1` — one hop). See `.env.example`.
 */
export function configureTrustProxy(app: Express): void {
  app.set('trust proxy', config.security.trustProxy)
}

/**
 * Helmet security headers — all directives set explicitly; no framework defaults.
 *
 * Production: full CSP lock-down, HSTS 2-year preload, CORP/COOP/COEP isolation.
 * Development/test: CSP and HSTS disabled so local tooling is not blocked.
 */
export function securityHeaders() {
  const isProduction = config.nodeEnv === 'production'

  return helmet({
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'none'"],
            scriptSrc: ["'none'"],
            styleSrc: ["'none'"],
            imgSrc: ["'none'"],
            connectSrc: ["'none'"],
            fontSrc: ["'none'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'none'"],
            frameSrc: ["'none'"],
            frameAncestors: ["'none'"],
            formAction: ["'none'"],
            upgradeInsecureRequests: [],
          },
        }
      : false,
    crossOriginEmbedderPolicy: isProduction,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: isProduction
      ? {
          maxAge: 63_072_000,
          includeSubDomains: true,
          preload: true,
        }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
    xDnsPrefetchControl: { allow: false },
    xDownloadOptions: true,
    xFrameOptions: { action: 'deny' },
    xXssProtection: false,
  })
}

/**
 * Sets `Permissions-Policy` to disable all browser features irrelevant to a
 * pure financial API (geolocation, camera, microphone, payment, usb, …).
 * Helmet does not yet provide a typed `permissionsPolicy` option so we set
 * this header manually after the helmet middleware runs.
 */
export function permissionsPolicy() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
    )
    next()
  }
}
