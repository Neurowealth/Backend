/**
 * Sentry error-tracking initialisation
 *
 * Imported as a side-effect in src/index.ts (after the OTel import but
 * before express and route imports):
 *
 *   import './telemetry/otel'      // must be first
 *   import './telemetry/sentry'    // second
 *   import express from 'express'
 *   …
 *
 * The module is intentionally a no-op when SENTRY_DSN is absent so the
 * app works in local development without any Sentry account.
 */

import * as Sentry from '@sentry/node'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

// ---------------------------------------------------------------------------
// Guard: no-op when DSN is not configured
// ---------------------------------------------------------------------------

const SENTRY_DSN = process.env.SENTRY_DSN

if (!SENTRY_DSN) {
  console.info('[Sentry] SENTRY_DSN not set — error reporting disabled')
} else {
  Sentry.init({
    dsn: SENTRY_DSN,

    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',

    // Attach the Git SHA / package version as the release so Sentry can link
    // errors to the exact deployment and show source maps.
    release: process.env.SENTRY_RELEASE ?? process.env.npm_package_version,

    // ---------------------------------------------------------------------------
    // Integrations
    // ---------------------------------------------------------------------------
    integrations: [
      // CPU profiling — pairs with performance monitoring
      nodeProfilingIntegration(),
    ],

    // ---------------------------------------------------------------------------
    // Sampling rates
    // ---------------------------------------------------------------------------

    // Capture 100 % of errors; tune down if event volume becomes expensive.
    sampleRate: 1.0,

    // Performance tracing — set to a low value in production to control costs.
    // Override via SENTRY_TRACES_SAMPLE_RATE env var.
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),

    // ---------------------------------------------------------------------------
    // Event filtering
    // ---------------------------------------------------------------------------

    /**
     * beforeSend fires for every captured *error* event.
     *
     * Rules applied here:
     *  1. Drop 4xx errors — these are client mistakes, not bugs in our code.
     *  2. Drop specific noisy non-actionable errors.
     *  3. Strip sensitive fields before the event leaves the server.
     */
    beforeSend(event, hint) {
      const err = hint?.originalException

      // Rule 1 — filter 4xx HTTP errors
      if (err && typeof err === 'object' && 'status' in err) {
        const status = (err as { status?: number }).status
        if (status !== undefined && status >= 400 && status < 500) {
          return null // drop
        }
      }

      // Also check statusCode (some frameworks use that name)
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
          return null
        }
      }

      // Rule 2 — drop intentionally thrown validation errors tagged with isClientError
      if (err && typeof err === 'object' && 'isClientError' in err) {
        if ((err as { isClientError?: boolean }).isClientError === true) {
          return null
        }
      }

      // Rule 3 — scrub sensitive fields from the request body
      if (event.request?.data && typeof event.request.data === 'object') {
        const sensitiveKeys = ['password', 'secret', 'token', 'pin', 'mnemonic', 'privateKey']
        const data = { ...(event.request.data as Record<string, unknown>) }
        for (const key of sensitiveKeys) {
          if (key in data) data[key] = '[Filtered]'
        }
        event.request.data = data
      }

      return event
    },
  })

  console.info(
    `[Sentry] Initialised → env=${process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV} dsn=***${SENTRY_DSN.slice(-6)}`
  )
}

// ---------------------------------------------------------------------------
// Convenience re-export so callers don't need to import @sentry/node directly
// ---------------------------------------------------------------------------
export { Sentry }