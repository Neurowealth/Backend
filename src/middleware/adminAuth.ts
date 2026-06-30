// src/middleware/adminAuth.ts
// #215 – adds granular scope checking per route + audit logging of scope failures
import type { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import db from '../db'
import { logger } from '../utils/logger'
import { recordAuthFailure } from '../utils/metrics'

const prisma = db as any

// ── Scope enum (#215) ──────────────────────────────────────────────────────

/**
 * Valid admin key scopes — ordered from least to most privileged.
 * A `super` key implicitly includes all other scopes.
 */
export const ADMIN_SCOPES = ['read', 'write', 'wallet', 'agent', 'super'] as const;
export type AdminScope = typeof ADMIN_SCOPES[number];

/** Scopes that `super` implicitly grants. */
const SUPER_GRANTS: Set<AdminScope> = new Set(ADMIN_SCOPES);

export interface AdminAuthContext {
  id: string
  name: string
  role: string
  scopes: string[]
}

// ── Internal helpers ────────────────────────────────────────────────────────

function deriveTokenPrefix(rawToken: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(rawToken).digest('hex')
}

function getTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token) return token
  }
  const legacyHeader = req.headers['x-admin-token']
  if (Array.isArray(legacyHeader))  return legacyHeader[0]?.trim() || undefined
  if (typeof legacyHeader === 'string') return legacyHeader.trim() || undefined
  return undefined
}

function unauthorized(res: Response): void {
  res.status(401).json({ success: false, error: 'Admin authentication required' })
}

function forbidden(res: Response): void {
  res.status(403).json({ success: false, error: 'Admin access revoked or expired' })
}

async function logScopeMismatch(
  req: Request,
  auth: AdminAuthContext,
  requiredScope: AdminScope,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminKeyId: auth.id,
        adminName:  auth.name,
        adminRole:  auth.role,
        action:     'scope_check',
        target:     req.originalUrl || req.path,
        result:     'denied',
        details:    { requiredScope, grantedScopes: auth.scopes },
        ipAddress:  req.ip ?? null,
        userAgent:  req.headers['user-agent'] ?? null,
        method:     req.method,
        path:       req.originalUrl || req.path,
      },
    })
  } catch (err) {
    logger.warn('[AdminAuth] Failed to write scope-mismatch audit log', { err })
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────

export async function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawToken = getTokenFromRequest(req)

  if (!rawToken) {
    recordAuthFailure(req.path, 'missing_token')
    unauthorized(res)
    return
  }

  try {
    const now         = new Date()
    const tokenPrefix = deriveTokenPrefix(rawToken)

    const candidates = await prisma.adminApiKey.findMany({
      where: {
        tokenPrefix,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, name: true, role: true, scopes: true, hash: true },
    })

    let matched: AdminAuthContext | null = null

    for (const candidate of candidates) {
      const isMatch = await bcrypt.compare(rawToken, candidate.hash)
      if (!isMatch) continue
      matched = { id: candidate.id, name: candidate.name, role: candidate.role, scopes: candidate.scopes }
      break
    }

    if (!matched) {
      recordAuthFailure(req.path, 'invalid_token')
      logger.warn('[AdminAuth] Invalid admin token attempt', {
        ip: req.ip, path: req.originalUrl || req.path, method: req.method,
      })
      forbidden(res)
      return
    }

    prisma.adminApiKey
      .update({ where: { id: matched.id }, data: { lastUsedAt: now } })
      .catch((err: unknown) =>
        logger.warn('[AdminAuth] Failed to update lastUsedAt', {
          id: matched!.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )

    res.locals.adminAuth = matched
    next()
  } catch (error) {
    recordAuthFailure(req.path, 'auth_error')
    logger.error('[AdminAuth] Middleware error', error)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

/**
 * requireAdminScope(scope)
 *
 * #215 – Factory that returns a middleware enforcing `scope` on the route.
 * Must be placed AFTER requireAdminAuth in the middleware chain.
 *
 * A key with scope `super` is granted access to all routes.
 * Scope mismatches are written to AdminAuditLog and return 403.
 *
 * @example
 *   router.delete('/key/:id',
 *     requireAdminAuth,
 *     requireAdminScope('super'),
 *     deleteKeyHandler,
 *   )
 */
export function requireAdminScope(scope: AdminScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = res.locals.adminAuth as AdminAuthContext | undefined

    if (!auth) {
      res.status(401).json({ success: false, error: 'Admin authentication required' })
      return
    }

    const scopes = auth.scopes as AdminScope[]
    const hasScope = scopes.includes(scope) || scopes.includes('super')

    if (!hasScope) {
      // #215 – audit log every scope-check failure
      await logScopeMismatch(req, auth, scope)
      logger.warn('[AdminAuth] Scope mismatch', {
        adminId: auth.id, requiredScope: scope, grantedScopes: scopes,
        path: req.originalUrl || req.path,
      })
      res.status(403).json({
        success: false,
        error:   `Admin scope '${scope}' required`,
        reason:  `Key '${auth.name}' has scopes [${scopes.join(', ')}]; '${scope}' is not granted.`,
      })
      return
    }

    next()
  }
}

/**
 * validateScopesInput
 *
 * #215 – Use in the key-creation endpoint to reject unknown scopes early.
 */
export function validateScopesInput(scopes: unknown): scopes is AdminScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) return false
  return scopes.every((s) => ADMIN_SCOPES.includes(s as AdminScope))
}