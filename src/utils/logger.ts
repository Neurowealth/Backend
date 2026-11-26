import winston from 'winston'
import * as fs from 'fs'
import * as path from 'path'
import { trace } from '@opentelemetry/api'
import { getCorrelationId } from './correlation'

// Ensure logs directory exists with fail-safe handling
const logsDir = path.join(process.cwd(), 'logs')
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
} catch (error) {
  // If we can't create logs directory, fall back to console-only logging
  console.error(
    '[Logger] Failed to create logs directory, using console-only:',
    error
  )
}

// Deny-list field keys (matched case-insensitively anywhere in the key name)
export const DENY_LIST_KEYS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'api-key',
  'privatekey',
  'private_key',
  'passphrase',
]

// PII & sensitive patterns to redact in string payloads
export const EMAIL_PATTERN =
  /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g

// Matches phone numbers with delimiters or international prefixes (+1, dashes, dots, spaces, parens)
export const PHONE_PATTERN =
  /(?<!\d)(?:(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}|\+\d{10,14})(?!\d)/g

// IPv4 addresses - redacts the last octet to preserve /24 subnet for diagnostic telemetry
export const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g

// IPv6 addresses - preserves first 3 blocks, masks the rest
export const IPV6_PATTERN =
  /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\b/g

// Stellar public keys (56 alphanumeric characters starting with 'G')
export const STELLAR_PUBLIC_KEY_PATTERN = /\bG[A-Z2-7]{55}\b/g

// Stellar secret keys (56 alphanumeric characters starting with 'S')
export const STELLAR_SECRET_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/g

// EVM/Ethereum addresses (42 hex characters starting with '0x')
export const EVM_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g

// Sensitive data patterns to redact
const SENSITIVE_PATTERNS = [
  /password["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /secret["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /token["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /api[_-]?key["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /authorization["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /cookie["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /(?:sk|pk)[-_][a-zA-Z0-9\-_]{16,}/g, // Stripe/OpenAI-like keys
  /xox[baprs]-[a-zA-Z0-9-]+/g, // Slack tokens
  /\b[a-f0-9]{64}\b/gi, // 64-char hex strings (likely encryption keys)
]

function redactSensitiveData(message: string): string {
  if (typeof message !== 'string') {
    return message
  }

  let redacted = message

  // 1. Redact emails keeping the domain (e.g. user@example.com -> ***@example.com)
  redacted = redacted.replace(
    EMAIL_PATTERN,
    (_match, domain) => `***@${domain}`
  )

  // 2. Redact phone numbers (e.g. +1-555-123-4567 -> ***-***-****)
  redacted = redacted.replace(PHONE_PATTERN, '***-***-****')

  // 3. Redact IPv4 addresses keeping /24 (e.g. 192.168.1.100 -> 192.168.1.***)
  redacted = redacted.replace(IPV4_PATTERN, (match) => {
    const parts = match.split('.')
    return `${parts[0]}.${parts[1]}.${parts[2]}.***`
  })

  // 4. Redact IPv6 addresses masking host portion
  redacted = redacted.replace(IPV6_PATTERN, (match) => {
    const parts = match.split(':')
    return `${parts.slice(0, 3).join(':')}:****`
  })

  // 5. Redact Stellar public keys (keep first/last 4)
  redacted = redacted.replace(
    STELLAR_PUBLIC_KEY_PATTERN,
    (match) => `${match.substring(0, 4)}...${match.substring(match.length - 4)}`
  )

  // 6. Redact Stellar secret keys completely
  redacted = redacted.replace(
    STELLAR_SECRET_KEY_PATTERN,
    '[REDACTED_SECRET_KEY]'
  )

  // 7. Redact EVM wallet addresses (keep first/last 4)
  redacted = redacted.replace(
    EVM_ADDRESS_PATTERN,
    (match) => `${match.substring(0, 4)}...${match.substring(match.length - 4)}`
  )

  // 8. Redact sensitive patterns (tokens, auth, keys, passwords)
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const visible = match.substring(0, 4)
      return `${visible}${'*'.repeat(Math.max(0, match.length - 4))}`
    })
  }

  return redacted
}

/**
 * Deep recursive scrubbing for nested metadata objects and payloads.
 * `seen` tracks only the current ancestor path, so shared (non-circular)
 * references are scrubbed normally and only true cycles become '[Circular]'.
 */
export function scrubPayload<T>(value: T, seen = new WeakSet()): T {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    return redactSensitiveData(value) as unknown as T
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (value instanceof Date) {
    return value
  }

  if (Buffer.isBuffer(value)) {
    return value
  }

  if (value instanceof Error) {
    const scrubbedErr: any = new Error(redactSensitiveData(value.message))
    scrubbedErr.name = value.name
    if (value.stack) {
      scrubbedErr.stack = redactSensitiveData(value.stack)
    }
    return scrubbedErr
  }

  if (typeof value === 'object' && seen.has(value as object)) {
    return '[Circular]' as unknown as T
  }

  if (Array.isArray(value)) {
    seen.add(value)
    const scrubbedArr = value.map((item) => scrubPayload(item, seen))
    seen.delete(value)
    return scrubbedArr as unknown as T
  }

  if (typeof value === 'object') {
    seen.add(value as object)

    const scrubbedObj: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      const lowerKey = k.toLowerCase()
      if (DENY_LIST_KEYS.some((deny) => lowerKey.includes(deny))) {
        scrubbedObj[k] = '[REDACTED]'
      } else if (
        (lowerKey === 'phone' ||
          lowerKey === 'phonenumber' ||
          lowerKey === 'mobile' ||
          lowerKey === 'telephone') &&
        typeof v === 'string'
      ) {
        scrubbedObj[k] = '***-***-****'
      } else if (
        (lowerKey === 'email' || lowerKey === 'useremail') &&
        typeof v === 'string'
      ) {
        scrubbedObj[k] = redactSensitiveData(v)
      } else if (
        (lowerKey === 'ip' ||
          lowerKey === 'ipaddress' ||
          lowerKey === 'clientip' ||
          lowerKey === 'remoteip') &&
        typeof v === 'string'
      ) {
        scrubbedObj[k] = redactSensitiveData(v)
      } else {
        scrubbedObj[k] = scrubPayload(v, seen)
      }
    }
    seen.delete(value as object)
    return scrubbedObj as unknown as T
  }

  return value
}

// Inject correlation ID from AsyncLocalStorage and the active trace context
// when present, so log lines can be joined to both requests and traces.
const correlationFormat = winston.format((info) => {
  const correlationId = getCorrelationId()
  if (correlationId && !info.correlationId) {
    info.correlationId = correlationId
  }
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (spanContext && !info.traceId) {
    info.traceId = spanContext.traceId
    info.spanId = spanContext.spanId
  }
  return info
})

/**
 * Winston format transform that scrubs all PII and deny-listed keys in place.
 * Ensures log sampling, debug modes, and JSON transforms cannot bypass scrubbing.
 */
export const scrubFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = redactSensitiveData(info.message)
  } else if (typeof info.message === 'object' && info.message !== null) {
    info.message = scrubPayload(info.message)
  }

  for (const [key, value] of Object.entries(info)) {
    if (
      key === 'level' ||
      key === 'timestamp' ||
      key === 'traceId' ||
      key === 'spanId' ||
      key === 'correlationId' ||
      typeof key === 'symbol'
    ) {
      continue
    }
    const lowerKey = key.toLowerCase()
    if (DENY_LIST_KEYS.some((deny) => lowerKey.includes(deny))) {
      info[key] = '[REDACTED]'
    } else {
      info[key] = scrubPayload(value)
    }
  }

  return info
})

// Custom format that redacts sensitive data and formats for console/text file
const redactFormat = winston.format.printf(
  ({ timestamp, level, message, ...meta }) => {
    const safeMessage =
      typeof message === 'string'
        ? redactSensitiveData(message)
        : JSON.stringify(scrubPayload(message))
    const safeMeta: any = scrubPayload(meta)
    const metaStr = Object.keys(safeMeta).length ? JSON.stringify(safeMeta) : ''
    return `${timestamp} [${level}]: ${safeMessage} ${metaStr}`
  }
)

// Determine log level from environment
const logLevel =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
const isProduction = process.env.NODE_ENV === 'production'

// Create base transports array
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      scrubFormat(),
      winston.format.colorize(),
      winston.format.timestamp(),
      redactFormat
    ),
  }),
]

// Add file transports only if logs directory is writable
if (fs.existsSync(logsDir) && fs.statSync(logsDir).isDirectory()) {
  try {
    // Error log with rotation
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        format: isProduction
          ? winston.format.combine(
              scrubFormat(),
              winston.format.timestamp(),
              winston.format.json()
            )
          : winston.format.combine(
              scrubFormat(),
              winston.format.timestamp(),
              redactFormat
            ),
      })
    )

    // Combined log with rotation
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        format: isProduction
          ? winston.format.combine(
              scrubFormat(),
              winston.format.timestamp(),
              winston.format.json()
            )
          : winston.format.combine(
              scrubFormat(),
              winston.format.timestamp(),
              redactFormat
            ),
      })
    )
  } catch (error) {
    console.error('[Logger] Failed to add file transports:', error)
  }
}

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    scrubFormat(),
    winston.format.timestamp(),
    correlationFormat(),
    redactFormat
  ),
  transports,
})

/** Child logger with a fixed correlationId (e.g. background jobs). */
export function createCorrelatedLogger(correlationId: string): winston.Logger {
  return logger.child({ correlationId })
}

// Optional cloud logging adapters (disabled by default)
export function addCloudLoggingAdapter(adapter: winston.transport): void {
  logger.add(adapter)
}

// Export for testing
export { redactSensitiveData, SENSITIVE_PATTERNS }

/**
 * Structured logging for background jobs and scheduled tasks.
 * Emits a single log entry with job name, duration, status, and correlation ID.
 *
 * @param jobName - Name of the job (e.g. "session_cleanup", "rebalance_check")
 * @param status - 'success' or 'failed'
 * @param durationSeconds - Execution time in seconds
 * @param correlationId - Optional correlation ID for tracing
 * @param details - Optional additional context (row count, error message, etc)
 */
export function logBackgroundJob(
  jobName: string,
  status: 'success' | 'failed' | 'dry_run' | 'skipped',
  durationSeconds: number,
  correlationId?: string,
  details?: Record<string, any>
): void {
  const logContext = {
    jobName,
    status,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    ...(correlationId && { correlationId }),
    ...details,
  }

  const message = `[${jobName}] completed in ${durationSeconds.toFixed(3)}s with status ${status}`

  if (status === 'failed') {
    logger.error(message, logContext)
  } else {
    logger.info(message, logContext)
  }
}
