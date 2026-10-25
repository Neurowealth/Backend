import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { logger } from '../utils/logger'
import {
  ErrorCodes,
  buildErrorResponse,
  codeForStatus,
  messageForStatus,
} from '../utils/errorResponse'
import { formatZodErrors } from './validate'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { Sentry } from '../telemetry/sentry'

// ---------------------------------------------------------------------------
// Helper: determine the HTTP status code from an error object.
//
// Supports express-style errors that carry `.status` or `.statusCode`.
// Falls back to 500 for anything we don't recognise or that is not a valid
// error status (a thrown `{ status: 200 }` must never produce a success).
// ---------------------------------------------------------------------------

function resolveStatusCode(err: unknown): number {
  if (err instanceof ZodError) return 400
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const candidate =
      typeof e['status'] === 'number'
        ? (e['status'] as number)
        : typeof e['statusCode'] === 'number'
          ? (e['statusCode'] as number)
          : undefined
    if (candidate !== undefined && candidate >= 400 && candidate <= 599) {
      return candidate
    }
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
// Helper: map a client error to a safe code, message and details.
// ---------------------------------------------------------------------------

function describeClientError(
  err: Error,
  statusCode: number
): { code: string; message: string; details?: unknown } {
  if (err instanceof ZodError) {
    return {
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Validation failed',
      details: formatZodErrors(err),
    }
  }

  const e = err as Error & { type?: string; code?: unknown; details?: unknown }

  // body-parser: malformed JSON — its message echoes parser internals
  if (e.type === 'entity.parse.failed') {
    return {
      code: ErrorCodes.BAD_REQUEST,
      message: 'Malformed JSON request body',
    }
  }

  return {
    code: typeof e.code === 'string' ? e.code : codeForStatus(statusCode),
    message: err.message || 'Request failed',
    ...(e.details !== undefined && { details: e.details }),
  }
}

// ---------------------------------------------------------------------------
// Error handler middleware
// ---------------------------------------------------------------------------

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Response already streaming — let Express close the connection.
  if (res.headersSent) {
    return next(err)
  }

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
    logger.warn(
      `[ErrorHandler] Client error ${statusCode}: ${err.message}`,
      logMeta
    )
  } else {
    logger.error(
      `[ErrorHandler] Server error ${statusCode}: ${err.message}`,
      logMeta
    )
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
      activeSpan.setAttribute('correlation.id', requestId)
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
      const user = (req as Request & { user?: { id: string; phone?: string } })
        .user

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
  //
  // 4xx: the error message is intended for the client.
  // 5xx: never expose err.message or the stack — the requestId is the handle
  //      for looking the failure up in logs, traces and Sentry.

  const isDevelopment = process.env.NODE_ENV === 'development'

  const { code, message, details } = isClientError(statusCode)
    ? describeClientError(err, statusCode)
    : {
        code: codeForStatus(statusCode),
        message: messageForStatus(statusCode),
        details: isDevelopment ? { message: err.message } : undefined,
      }

  res
    .status(statusCode)
    .json(
      buildErrorResponse(
        statusCode,
        code,
        message,
        requestId ?? 'unknown',
        details
      )
    )
}
