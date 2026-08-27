import type { NextFunction, Request, Response } from 'express'
import { config } from '../config/env'
import { logger } from '../utils/logger'
import { recordRequestTimeout } from '../utils/metrics'

const HEALTH_TIMEOUT_MS = 5_000
const AGENT_TIMEOUT_MS = 60_000

export interface RequestTimeoutConfig {
  timeoutMs: number
  routeGroup: 'health' | 'agent' | 'general'
}

export function resolveRequestTimeout(path: string): RequestTimeoutConfig {
  if (path === '/metrics' || path.startsWith('/health')) {
    return { timeoutMs: HEALTH_TIMEOUT_MS, routeGroup: 'health' }
  }

  if (path.startsWith('/api/v1/agent') || path.startsWith('/api/agent')) {
    return { timeoutMs: AGENT_TIMEOUT_MS, routeGroup: 'agent' }
  }

  return { timeoutMs: config.requestTimeoutMs, routeGroup: 'general' }
}

export function requestTimeoutMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const timeout = resolveRequestTimeout(req.path)

  const timer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) {
      return
    }

    recordRequestTimeout(timeout.routeGroup)
    logger.warn('[RequestTimeout] Request timed out', {
      path: req.path,
      method: req.method,
      timeoutMs: timeout.timeoutMs,
      correlationId: req.correlationId,
      routeGroup: timeout.routeGroup,
    })

    res.status(504).json({ error: 'Request timed out' })
  }, timeout.timeoutMs)

  res.on('finish', () => clearTimeout(timer))
  res.on('close', () => clearTimeout(timer))
  next()
}
