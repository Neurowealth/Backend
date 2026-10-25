/**
 * Standardized error response contract for all API routes.
 *
 * All error responses follow this canonical format:
 * {
 *   status: number,        // HTTP status code
 *   code: string,          // machine-readable error code, e.g. VALIDATION_ERROR
 *   message: string,       // human-readable, sanitized message
 *   error: string,         // deprecated alias of `message` for legacy clients
 *   details?: unknown,     // optional structured context (e.g. field errors)
 *   requestId: string,     // matches the X-Request-ID response header
 *   timestamp: string      // ISO-8601
 * }
 */

export interface FieldError {
  field: string
  message: string
}

export interface ErrorResponse {
  status: number
  code: string
  message: string
  /** @deprecated Use `message`. Kept so pre-standardization clients keep working. */
  error: string
  details?: unknown
  requestId: string
  timestamp: string
}

export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
} as const

export const INTERNAL_ERROR_MESSAGE = 'Internal server error'

const STATUS_CODES: Record<number, string> = {
  400: ErrorCodes.BAD_REQUEST,
  401: ErrorCodes.UNAUTHORIZED,
  403: ErrorCodes.FORBIDDEN,
  404: ErrorCodes.NOT_FOUND,
  405: ErrorCodes.METHOD_NOT_ALLOWED,
  409: ErrorCodes.CONFLICT,
  413: ErrorCodes.PAYLOAD_TOO_LARGE,
  415: ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
  422: ErrorCodes.VALIDATION_ERROR,
  429: ErrorCodes.RATE_LIMITED,
  500: ErrorCodes.INTERNAL_ERROR,
  502: ErrorCodes.BAD_GATEWAY,
  503: ErrorCodes.SERVICE_UNAVAILABLE,
  504: ErrorCodes.TIMEOUT,
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
  429: 'Too many requests',
  500: INTERNAL_ERROR_MESSAGE,
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Request timed out',
}

/** Default machine-readable code for an HTTP status. */
export function codeForStatus(status: number): string {
  if (STATUS_CODES[status]) return STATUS_CODES[status]
  return status >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.BAD_REQUEST
}

/** Default human-readable message for an HTTP status. */
export function messageForStatus(status: number): string {
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status]
  return status >= 500 ? INTERNAL_ERROR_MESSAGE : 'Request failed'
}

/**
 * Build a standardized error response object.
 */
export function buildErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown
): ErrorResponse {
  return {
    status,
    code,
    message,
    error: message,
    ...(details !== undefined && { details }),
    requestId,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Error response builders for common HTTP status codes.
 */
export const ErrorResponses = {
  badRequest: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      message,
      requestId,
      details
    ),

  unauthorized: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(
      401,
      ErrorCodes.UNAUTHORIZED,
      message,
      requestId,
      details
    ),

  forbidden: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(403, ErrorCodes.FORBIDDEN, message, requestId, details),

  notFound: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(404, ErrorCodes.NOT_FOUND, message, requestId, details),

  conflict: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(409, ErrorCodes.CONFLICT, message, requestId, details),

  rateLimited: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(
      429,
      ErrorCodes.RATE_LIMITED,
      message,
      requestId,
      details
    ),

  validationError: (
    message: string,
    requestId: string,
    details?: FieldError[] | unknown
  ) =>
    buildErrorResponse(
      400,
      ErrorCodes.VALIDATION_ERROR,
      message,
      requestId,
      details
    ),

  internalError: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      message,
      requestId,
      details
    ),

  serviceUnavailable: (message: string, requestId: string, details?: unknown) =>
    buildErrorResponse(
      503,
      ErrorCodes.SERVICE_UNAVAILABLE,
      message,
      requestId,
      details
    ),
}

// Fields owned by the canonical envelope; anything else a handler returns is
// preserved alongside them so existing clients keep working.
const ENVELOPE_KEYS = new Set([
  'status',
  'code',
  'message',
  'error',
  'details',
  'requestId',
  'timestamp',
  'stack',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface NormalizeOptions {
  /** Replace 500 messages with a generic one and drop details. */
  sanitizeInternal: boolean
}

/**
 * Convert any error body a handler produced — `{ error: 'msg' }`,
 * `{ error: { code, message } }`, `{ message }`, a bare string, etc. — into
 * the canonical ErrorResponse shape.
 */
export function normalizeErrorBody(
  status: number,
  body: unknown,
  requestId: string,
  options: NormalizeOptions
): ErrorResponse & Record<string, unknown> {
  const obj = isPlainObject(body) ? body : {}
  const nested = isPlainObject(obj.error) ? obj.error : undefined

  const pickString = (...values: unknown[]): string | undefined =>
    values.find((v): v is string => typeof v === 'string' && v.length > 0)

  let message =
    pickString(
      nested?.message,
      obj.error,
      obj.message,
      typeof body === 'string' ? body : undefined
    ) ?? messageForStatus(status)

  let details = nested?.details ?? obj.details

  let code = pickString(nested?.code, obj.code)
  if (!code) {
    code =
      (status === 400 || status === 422) && details !== undefined
        ? ErrorCodes.VALIDATION_ERROR
        : codeForStatus(status)
  }

  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!ENVELOPE_KEYS.has(key)) extras[key] = value
  }

  if (status === 500 && options.sanitizeInternal) {
    message = INTERNAL_ERROR_MESSAGE
    details = undefined
    code = ErrorCodes.INTERNAL_ERROR
  }

  return {
    ...extras,
    ...buildErrorResponse(
      status,
      code,
      message,
      pickString(obj.requestId) ?? requestId,
      details
    ),
  }
}
