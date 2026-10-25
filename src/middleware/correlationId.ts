import { Request, Response, NextFunction } from 'express'
import { trace } from '@opentelemetry/api'
import {
  resolveCorrelationId,
  runWithCorrelationId,
} from '../utils/correlation'

export const REQUEST_ID_HEADER = 'X-Request-ID'

/**
 * Assigns a request-scoped correlation ID from incoming headers or a new UUID.
 * Propagates the ID through AsyncLocalStorage for downstream logging and
 * tags the active OpenTelemetry span so traces can be looked up by request ID.
 *
 * Register this before any other middleware so that early rejections (CORS,
 * body parsing, rate limiting) still carry a request ID.
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const correlationId = resolveCorrelationId(
    req.headers as Record<string, string | string[] | undefined>
  )

  req.correlationId = correlationId
  res.locals.correlationId = correlationId
  res.setHeader(REQUEST_ID_HEADER, correlationId)
  trace.getActiveSpan()?.setAttribute('http.request_id', correlationId)

  runWithCorrelationId(correlationId, () => next())
}
