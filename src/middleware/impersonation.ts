import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { config } from '../config'
import db from '../db'
import { logger } from '../utils/logger'

const IMPERSONATION_TTL_MINUTES = 30
const IMPERSONATION_SECRET = config.jwt.seed

/**
 * Routes where impersonation is never permitted regardless of admin role.
 * Covers withdrawals, erasure, API key management, and treasury operations.
 */
const HIGH_RISK_PATH_PREFIXES = [
  '/api/withdrawals',
  '/api/wallet/withdraw',
  '/api/users/me/erase',
  '/api/users/delete',
  '/api/api-keys',
  '/api/treasury',
  '/api/admin/treasury',
  '/api/stellar/sign',
  '/api/stellar/send',
  '/api/mfa',
  '/api/totp',
]

export interface ImpersonationContext {
  adminId: string
  adminName: string
  targetUserId: string
  sessionId: string
  createdAt: Date
  expiresAt: Date
  ipAddress?: string
  reason?: string
}

/**
 * Generate an impersonation token for a target user.
 */
export function generateImpersonationToken(
  adminId: string,
  adminName: string,
  targetUserId: string,
  options?: { ipAddress?: string; reason?: string }
): string {
  const sessionId = crypto.randomUUID()
  const createdAt = new Date()
  const expiresAt = new Date(
    createdAt.getTime() + IMPERSONATION_TTL_MINUTES * 60 * 1000
  )

  const payload: ImpersonationContext = {
    adminId,
    adminName,
    targetUserId,
    sessionId,
    createdAt,
    expiresAt,
    ipAddress: options?.ipAddress,
    reason: options?.reason,
  }

  return jwt.sign(payload, IMPERSONATION_SECRET, {
    expiresIn: `${IMPERSONATION_TTL_MINUTES}m`,
  })
}

/**
 * Verify and decode an impersonation token.
 */
export function verifyImpersonationToken(
  token: string
): ImpersonationContext | null {
  try {
    const decoded = jwt.verify(
      token,
      IMPERSONATION_SECRET
    ) as ImpersonationContext

    if (new Date() > new Date(decoded.expiresAt)) {
      return null
    }

    return decoded
  } catch (error) {
    logger.warn('[Impersonation] Failed to verify impersonation token', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Middleware to check if the current request is an impersonation session
 * and reject write operations.
 */
export function requireNotImpersonation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    const impersonationContext = verifyImpersonationToken(token)

    if (impersonationContext) {
      logger.warn(
        '[Impersonation] Write blocked during impersonation session',
        {
          sessionId: impersonationContext.sessionId,
          adminId: impersonationContext.adminId,
          targetUserId: impersonationContext.targetUserId,
          path: req.path,
          method: req.method,
        }
      )
      res.status(403).json({
        success: false,
        error: 'Write operations are not allowed during impersonation sessions',
      })
      return
    }
  }

  next()
}

/**
 * Middleware that blocks impersonation tokens from accessing high-risk routes
 * (withdrawals, erasure, API key management, treasury operations).
 * Apply before any route handler on these paths.
 */
export function blockHighRiskImpersonation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return next()
  }

  const token = authHeader.slice(7).trim()
  const impersonationContext = verifyImpersonationToken(token)

  if (!impersonationContext) return next()

  const isHighRisk = HIGH_RISK_PATH_PREFIXES.some((prefix) =>
    req.path.startsWith(prefix)
  )

  if (isHighRisk) {
    logger.warn(
      '[Impersonation] High-risk route blocked for impersonation session',
      {
        sessionId: impersonationContext.sessionId,
        adminId: impersonationContext.adminId,
        targetUserId: impersonationContext.targetUserId,
        path: req.path,
      }
    )
    res.status(403).json({
      success: false,
      error: 'This operation is not permitted during an impersonation session',
    })
    return
  }

  next()
}

/**
 * Middleware to extract impersonation context from request.
 */
export function extractImpersonationContext(
  req: Request
): ImpersonationContext | null {
  const authHeader = req.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    return verifyImpersonationToken(token)
  }
  return null
}
