import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import { ErrorResponses } from '../utils/errorResponse'

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = req.correlationId

  logger.error(`Unhandled error: ${err.message}`, {
    correlationId: requestId,
    stack: err.stack,
    path: req.path,
    method: req.method,
  })

  const isDevelopment = process.env.NODE_ENV === 'development'
  const errorResponse = ErrorResponses.internalError(
    'Internal server error',
    requestId ?? 'unknown',
    isDevelopment ? { message: err.message } : undefined
  )

  res.status(500).json(errorResponse)
}