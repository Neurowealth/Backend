import { Request, Response, NextFunction } from 'express'
import {
  resolveCorrelationId,
  runWithCorrelationId,
} from '../utils/correlation'

export const REQUEST_ID_HEADER = 'X-Request-ID'

/**
 * Assigns a request-scoped correlation ID from incoming headers or a new UUID.
 * Propagates the ID through AsyncLocalStorage for downstream logging.
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

  runWithCorrelationId(correlationId, () => next())
}
