/**
 * Internal endpoints authentication guard
 * Protects /metrics and /api/agent/status endpoints
 * 
 * Allows access via:
 * 1. X-Internal-Token header matching INTERNAL_SERVICE_TOKEN
 * 2. IP allowlist from INTERNAL_IP_WHITELIST
 * 3. Admin token from ADMIN_API_TOKEN
 */

import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'

/**
 * Parse comma-separated IP list from env var
 */
function parseIpWhitelist(): Set<string> {
  const whitelist = process.env.INTERNAL_IP_WHITELIST || ''
  if (!whitelist.trim()) return new Set()
  return new Set(whitelist.split(',').map(ip => ip.trim()).filter(Boolean))
}

/**
 * Get client IP, accounting for proxies
 */
function getClientIp(req: Request): string {
  // req.ip is already set by Express with trust proxy
  return req.ip || req.socket.remoteAddress || 'unknown'
}

/**
 * Middleware to protect internal endpoints
 */
export function internalAuthGuard(req: Request, res: Response, next: NextFunction): void {
  const clientIp = getClientIp(req)
  const internalToken = req.headers['x-internal-token'] as string | undefined
  const adminToken = req.headers['authorization']?.replace('Bearer ', '') as string | undefined

  // Check 1: X-Internal-Token header
  if (internalToken && process.env.INTERNAL_SERVICE_TOKEN) {
    if (internalToken === process.env.INTERNAL_SERVICE_TOKEN) {
      logger.info('[AuthGuard] Internal token accepted', { clientIp, endpoint: req.path })
      next()
      return
    }
    logger.warn('[AuthGuard] Invalid internal token attempted', { clientIp, endpoint: req.path })
  }

  // Check 2: IP allowlist
  const ipWhitelist = parseIpWhitelist()
  if (ipWhitelist.size > 0 && ipWhitelist.has(clientIp)) {
    logger.info('[AuthGuard] IP allowlist match', { clientIp, endpoint: req.path })
    next()
    return
  }

  // Check 3: Admin token
  if (adminToken && process.env.ADMIN_API_TOKEN) {
    if (adminToken === process.env.ADMIN_API_TOKEN) {
      logger.info('[AuthGuard] Admin token accepted for internal endpoint', { clientIp, endpoint: req.path })
      next()
      return
    }
    logger.warn('[AuthGuard] Invalid admin token attempted on internal endpoint', { clientIp, endpoint: req.path })
  }

  // Reject: no valid auth method
  logger.warn('[AuthGuard] Unauthorized access attempt', {
    clientIp,
    endpoint: req.path,
    method: req.method,
    hasInternalToken: !!internalToken,
    hasAdminToken: !!adminToken,
    ipWhitelistSize: ipWhitelist.size,
  })

  // Return 403 to avoid info disclosure (don't say which method failed)
  res.status(403).json({
    success: false,
    error: 'Forbidden',
  })
}

/**
 * Variant that returns 404 instead of 403 (full info hiding)
 * Use for endpoints you want to pretend don't exist
 */
export function internalAuthGuardStrict(req: Request, res: Response, next: NextFunction): void {
  const clientIp = getClientIp(req)
  const internalToken = req.headers['x-internal-token'] as string | undefined
  const adminToken = req.headers['authorization']?.replace('Bearer ', '') as string | undefined

  // Check 1: X-Internal-Token header
  if (internalToken && process.env.INTERNAL_SERVICE_TOKEN) {
    if (internalToken === process.env.INTERNAL_SERVICE_TOKEN) {
      logger.info('[AuthGuard-Strict] Internal token accepted', { clientIp, endpoint: req.path })
      next()
      return
    }
  }

  // Check 2: IP allowlist
  const ipWhitelist = parseIpWhitelist()
  if (ipWhitelist.size > 0 && ipWhitelist.has(clientIp)) {
    logger.info('[AuthGuard-Strict] IP allowlist match', { clientIp, endpoint: req.path })
    next()
    return
  }

  // Check 3: Admin token
  if (adminToken && process.env.ADMIN_API_TOKEN) {
    if (adminToken === process.env.ADMIN_API_TOKEN) {
      logger.info('[AuthGuard-Strict] Admin token accepted', { clientIp, endpoint: req.path })
      next()
      return
    }
  }

  // Reject: return 404 to hide endpoint existence
  logger.warn('[AuthGuard-Strict] Unauthorized access attempt (404 response)', {
    clientIp,
    endpoint: req.path,
  })

  res.status(404).json({
    success: false,
    error: 'Not found',
  })
}
