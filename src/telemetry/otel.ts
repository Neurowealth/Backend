/**
 * OpenTelemetry SDK initialisation
 *
 * IMPORTANT: This module must be imported before any other application
 * imports in src/index.ts so the auto-instrumentations can patch
 * Express, Prisma, and the Node.js HTTP client before they are loaded.
 *
 * Usage in src/index.ts (very first lines):
 *   import './telemetry/otel'          // side-effect import — must be first
 *   import express from 'express'
 *   …
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { diag, DiagConsoleLogger, DiagLogLevel, Span } from '@opentelemetry/api'
import { PrismaInstrumentation } from '@prisma/instrumentation'
import type { IncomingMessage } from 'http'

// ---------------------------------------------------------------------------
// Guard: no-op when OTEL is explicitly disabled or endpoint is not configured
// ---------------------------------------------------------------------------

const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const OTEL_ENABLED = process.env.OTEL_ENABLED !== 'false' && !!OTEL_ENDPOINT

const SENSITIVE_QUERY_KEYS = new Set(['token', 'code', 'signature'])

export function redactSensitiveQuery(url: string): string {
  const queryIndex = url.indexOf('?')
  if (queryIndex < 0) return url
  const fragmentIndex = url.indexOf('#', queryIndex)
  const end = fragmentIndex < 0 ? url.length : fragmentIndex
  const query = url.slice(queryIndex + 1, end)
  const redacted = query
    .split('&')
    .map((part) => {
      const equals = part.indexOf('=')
      const rawKey = equals < 0 ? part : part.slice(0, equals)
      let key = rawKey
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
      } catch {}
      return SENSITIVE_QUERY_KEYS.has(key.toLowerCase())
        ? `${rawKey}=[REDACTED]`
        : part
    })
    .join('&')
  return `${url.slice(0, queryIndex)}?${redacted}${url.slice(end)}`
}

export function recordIncomingRequestAttributes(
  span: Span,
  request: IncomingMessage
): void {
  const target = redactSensitiveQuery(request.url ?? '')
  const host = request.headers.host
  const protocol = request.headers['x-forwarded-proto'] ?? 'http'
  span.setAttribute('http.target', target)
  span.setAttribute(
    'url.query',
    target.includes('?') ? target.slice(target.indexOf('?') + 1) : ''
  )
  span.setAttribute('url.full', `${protocol}://${host ?? 'unknown'}${target}`)
}

if (!OTEL_ENABLED) {
  // Emit a single info line so ops knows tracing is off — not an error
  // eslint-disable-next-line no-console -- telemetry bootstraps before the winston logger can be instrumented
  console.info(
    '[OTel] OTEL_EXPORTER_OTLP_ENDPOINT not set or OTEL_ENABLED=false — distributed tracing disabled'
  )
}

// ---------------------------------------------------------------------------
// Debug logging (only in development)
// ---------------------------------------------------------------------------

if (
  process.env.NODE_ENV === 'development' &&
  process.env.OTEL_DEBUG === 'true'
) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
}

// ---------------------------------------------------------------------------
// SDK setup
// ---------------------------------------------------------------------------

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'backend'
const serviceVersion = process.env.npm_package_version ?? '0.0.0'

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: serviceVersion,
  'deployment.environment': process.env.NODE_ENV ?? 'development',
})

/**
 * Build the span processor to use.
 *
 * - Production / staging  → BatchSpanProcessor → OTLP collector
 * - Development with no endpoint → ConsoleSpanExporter (pretty-print to stdout)
 */
function buildSpanProcessor() {
  if (OTEL_ENABLED) {
    const exporter = new OTLPTraceExporter({
      url: `${OTEL_ENDPOINT}/v1/traces`,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        ? Object.fromEntries(
            process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map((h) => {
              const [k, ...v] = h.split('=')
              return [k.trim(), v.join('=').trim()]
            })
          )
        : {},
    })
    return new BatchSpanProcessor(exporter)
  }

  // Dev fallback — log spans to console so developers can still see traces
  if (process.env.NODE_ENV === 'development') {
    return new SimpleSpanProcessor(new ConsoleSpanExporter())
  }

  return undefined
}

const spanProcessor = buildSpanProcessor()

const sdk = new NodeSDK({
  resource,
  ...(spanProcessor ? { spanProcessor } : {}),

  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        requestHook: (span, request) => {
          recordIncomingRequestAttributes(span, request as IncomingMessage)
        },
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? ''
          return url.startsWith('/health') || url === '/metrics'
        },
      },
    }),
    new PrismaInstrumentation(), // ✅ separate, properly typed
  ],
})

// ---------------------------------------------------------------------------
// Start and register graceful-shutdown hook
// ---------------------------------------------------------------------------

if (spanProcessor) {
  try {
    sdk.start()
    // eslint-disable-next-line no-console -- telemetry bootstraps before the winston logger can be instrumented
    console.info(
      `[OTel] Tracing initialised → service=${serviceName}@${serviceVersion}`
    )
  } catch (err) {
    console.error('[OTel] Failed to start OpenTelemetry SDK:', err)
    // Non-fatal — tracing failure must never crash the server
  }

  // Flush remaining spans before the process exits
  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .catch((err) => console.error('[OTel] SDK shutdown error:', err))
  })
}

// ---------------------------------------------------------------------------
// Export the active tracer for manual instrumentation elsewhere in the app
// ---------------------------------------------------------------------------

export { sdk }
