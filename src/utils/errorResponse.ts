/**
 * Standardized error response contract for all API routes.
 *
 * All error responses follow this canonical format:
 * {
 *   error: {
 *     code: string,
 *     message: string,
 *     details?: object
 *   },
 *   requestId: string,
 *   timestamp: string
 * }
 */

export interface ErrorResponse {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
  requestId: string
  timestamp: string
}

export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const

/**
 * Build a standardized error response object.
 */
export function buildErrorResponse(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>
): ErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details && { details }),
    },
    requestId,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Error response builders for common HTTP status codes.
 */
export const ErrorResponses = {
  badRequest: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.BAD_REQUEST, message, requestId, details),

  unauthorized: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.UNAUTHORIZED, message, requestId, details),

  forbidden: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.FORBIDDEN, message, requestId, details),

  notFound: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.NOT_FOUND, message, requestId, details),

  conflict: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.CONFLICT, message, requestId, details),

  rateLimited: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.RATE_LIMITED, message, requestId, details),

  validationError: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.VALIDATION_ERROR, message, requestId, details),

  internalError: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.INTERNAL_ERROR, message, requestId, details),

  serviceUnavailable: (message: string, requestId: string, details?: Record<string, unknown>) =>
    buildErrorResponse(ErrorCodes.SERVICE_UNAVAILABLE, message, requestId, details),
}
