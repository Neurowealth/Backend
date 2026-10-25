import { Request, Response, NextFunction } from 'express'
import { ErrorResponses, normalizeErrorBody } from '../utils/errorResponse'

// Health probes return status documents (e.g. 503 { status: 'not_ready' }),
// not errors — leave their payloads alone.
const EXEMPT_PATH = /^\/(health|metrics)(\/|$)/

function shouldSanitizeInternal(): boolean {
  return process.env.NODE_ENV !== 'development'
}

/**
 * Rewrites every JSON response with a 4xx/5xx status into the canonical
 * ErrorResponse shape (status, code, message, details, requestId, timestamp).
 *
 * Handlers and middleware can keep calling `res.status(n).json({ error })`;
 * the shape is enforced in one place. 500 messages are sanitized outside
 * development so internal error text never reaches clients.
 *
 * Register right after correlationIdMiddleware so that every later
 * middleware (CORS, body parsing, auth, rate limiting) is covered.
 */
export function errorResponseMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (EXEMPT_PATH.test(req.path)) return next()

  const originalJson = res.json.bind(res)

  res.json = ((body?: unknown) => {
    if (res.statusCode < 400) return originalJson(body)

    const requestId =
      req.correlationId ?? (res.locals.correlationId as string) ?? 'unknown'

    return originalJson(
      normalizeErrorBody(res.statusCode, body, requestId, {
        sanitizeInternal: shouldSanitizeInternal(),
      })
    )
  }) as Response['json']

  next()
}

/**
 * 404 handler for requests that did not match any route. Register after all
 * routers and before the error handlers.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res
    .status(404)
    .json(
      ErrorResponses.notFound(
        `Route ${req.method} ${req.path} not found`,
        req.correlationId ?? 'unknown'
      )
    )
}
