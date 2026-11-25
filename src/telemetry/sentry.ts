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
import { config } from '../config/env'

const SENSITIVE_FIELD =
  /pass|secret|token|key|mnemonic|seed|code|signature|authorization|cookie/i

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_FIELD.test(key) ? '[Filtered]' : scrubValue(child)
  }
  return result
}

function scrubQueryString(query: string): string {
  return query
    .split('&')
    .map((part) => {
      const prefix = part.startsWith('?') ? '?' : ''
      const parameter = prefix ? part.slice(1) : part
      const equals = parameter.indexOf('=')
      const rawKey = equals < 0 ? parameter : parameter.slice(0, equals)
      let key = rawKey
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
      } catch {}
      if (!SENSITIVE_FIELD.test(key)) return part
      return `${prefix}${rawKey}=[Filtered]`
    })
    .join('&')
}

function scrubQueryValue(query: unknown): unknown {
  if (typeof query === 'string') return scrubQueryString(query)
  if (Array.isArray(query)) {
    return query.map(([key, value]) =>
      SENSITIVE_FIELD.test(String(key)) ? [key, '[Filtered]'] : [key, value]
    )
  }
  return scrubValue(query)
}

export function beforeSend(event: Sentry.ErrorEvent, hint?: Sentry.EventHint) {
  const err = hint?.originalException
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status
    if (status !== undefined && status >= 400 && status < 500) return null
  }
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500)
      return null
  }
  if (
    err &&
    typeof err === 'object' &&
    'isClientError' in err &&
    (err as { isClientError?: boolean }).isClientError
  )
    return null

  if (event.request?.data && typeof event.request.data === 'object') {
    event.request.data = scrubValue(
      event.request.data
    ) as typeof event.request.data
  }
  if (event.request?.headers) {
    event.request.headers = scrubValue(
      event.request.headers
    ) as typeof event.request.headers
  }
  if (event.request?.query_string) {
    event.request.query_string = scrubQueryValue(
      event.request.query_string
    ) as typeof event.request.query_string
  }
  return event
}

// ---------------------------------------------------------------------------
// Guard: no-op when DSN is not configured
// ---------------------------------------------------------------------------

const SENTRY_DSN = process.env.SENTRY_DSN

if (!SENTRY_DSN) {
  // eslint-disable-next-line no-console -- telemetry bootstraps before the winston logger can be instrumented
  console.info('[Sentry] SENTRY_DSN not set — error reporting disabled')
} else {
  Sentry.init({
    dsn: SENTRY_DSN,

    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',

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
    tracesSampleRate: config.telemetry.sentryTracesSampleRate,

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
    beforeSend,
  })

  // eslint-disable-next-line no-console -- telemetry bootstraps before the winston logger can be instrumented
  console.info(
    `[Sentry] Initialised → env=${process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV} dsn=***${SENTRY_DSN.slice(-6)}`
  )
}

// ---------------------------------------------------------------------------
// Convenience re-export so callers don't need to import @sentry/node directly
// ---------------------------------------------------------------------------
export { Sentry }
