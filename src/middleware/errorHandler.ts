import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import { ErrorResponses } from '../utils/errorResponse'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { Sentry } from '../telemetry/sentry'

// ---------------------------------------------------------------------------
// Helper: determine the HTTP status code from an error object.
//
// Supports express-style errors that carry `.status` or `.statusCode`.
// Falls back to 500 for anything we don't recognise.
// ---------------------------------------------------------------------------

function resolveStatusCode(err: unknown): number {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    if (typeof e['status'] === 'number') return e['status'] as number
    if (typeof e['statusCode'] === 'number') return e['statusCode'] as number
  }
  return 500
}

// ---------------------------------------------------------------------------
// Helper: is this a client error (4xx)?
// ---------------------------------------------------------------------------

function isClientError(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500
}

// ---------------------------------------------------------------------------
// Error handler middleware
// ---------------------------------------------------------------------------

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const requestId = req.correlationId
  const statusCode = resolveStatusCode(err)

  // ── Logging ────────────────────────────────────────────────────────────────
  //
  // Always log.  4xx go at warn level (expected client mistakes);
  // 5xx go at error level (unexpected bugs).

  const logMeta = {
    correlationId: requestId,
    statusCode,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: (req as Request & { user?: { id: string } }).user?.id,
  }

  if (isClientError(statusCode)) {
    logger.warn(`[ErrorHandler] Client error ${statusCode}: ${err.message}`, logMeta)
  } else {
    logger.error(`[ErrorHandler] Server error ${statusCode}: ${err.message}`, logMeta)
  }

  // ── OpenTelemetry — mark the active span as failed ────────────────────────
  //
  // If there is an active span for this request (created by the Express
  // auto-instrumentation) we record the exception and set the span status
  // to ERROR so the trace is clearly marked as failed in Jaeger/Tempo.

  const activeSpan = trace.getActiveSpan()
  if (activeSpan) {
    activeSpan.recordException(err)

    if (!isClientError(statusCode)) {
      // Only mark 5xx as ERROR spans — 4xx are expected and should not
      // pollute error-rate SLOs in your tracing backend.
      activeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
      })
    }

    activeSpan.setAttribute('http.status_code', statusCode)
    activeSpan.setAttribute('error.type', err.constructor.name)

    if (requestId) {
      activeSpan.setAttribute('correlation.id', requestId ?? 'unknown')
    }
  }

  // ── Sentry — capture 5xx errors only ─────────────────────────────────────
  //
  // 4xx errors are client mistakes and must NOT be sent to Sentry.
  // The Sentry `beforeSend` filter in telemetry/sentry.ts is a second line
  // of defence; we also skip the capture call entirely here for efficiency.

  if (!isClientError(statusCode)) {
    // Attach request context so the Sentry issue shows who was affected
    Sentry.withScope((scope) => {
      const user = (req as Request & { user?: { id: string; phone?: string } }).user

      if (user?.id) {
        scope.setUser({ id: user.id, phone: user.phone })
      }

      scope.setTag('correlation_id', requestId ?? 'unknown')  
      scope.setTag('http.method', req.method)
      scope.setTag('http.route', req.route?.path ?? req.path)
      scope.setTag('status_code', String(statusCode))

      scope.setContext('request', {
        path: req.path,
        method: req.method,
        correlationId: requestId,
        userAgent: req.headers['user-agent'],
      })

      Sentry.captureException(err)
    })
  }

  // ── HTTP response ──────────────────────────────────────────────────────────

  const isDevelopment = process.env.NODE_ENV === 'development'

  const errorResponse = ErrorResponses.internalError(
    isClientError(statusCode) ? err.message : 'Internal server error',
    requestId ?? 'unknown',
    isDevelopment ? { message: err.message } : undefined
  )

  res.status(statusCode).json(errorResponse)
}