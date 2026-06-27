import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import { recordHttpRequest } from '../utils/metrics'

// Routes that must always be logged regardless of status/duration
const ALWAYS_LOG_PATTERNS = [
  /^\/auth\//,
  /^\/agent\//,
  /^\/stellar\//,
  /^\/api\/stellar\//,
  /dlq/i,
]

const LOG_SAMPLE_RATE = parseFloat(process.env.LOG_SAMPLE_RATE ?? '0.1')

function shouldLog(req: Request, status: number, duration: number): boolean {
  // Always log errors and slow requests
  if (status >= 400 || duration > 1000) return true

  // Always log critical domains
  const path = req.path
  if (ALWAYS_LOG_PATTERNS.some((pattern) => pattern.test(path))) return true

  // Sample healthy requests
  return Math.random() < LOG_SAMPLE_RATE
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now()

  res.on('finish', () => {
    const duration = Date.now() - start
    const durationSeconds = duration / 1000
    const status = res.statusCode

    const sampled = shouldLog(req, status, duration)

    if (sampled) {
      logger.info(`${req.method} ${req.path}`, {
        correlationId: req.correlationId,
        status,
        duration: `${duration}ms`,
        ip: req.ip,
        sampled: true,
      })
    }

    const route = req.route?.path || req.path
    recordHttpRequest(req.method, route, status, durationSeconds)
  })

  next()
}