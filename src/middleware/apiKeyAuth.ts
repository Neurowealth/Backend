import type { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config'
import type { UserScope } from '../auth/scopes'

const prisma = db as any

export type AuthKind = 'session' | 'api_key'

function deriveTokenPrefix(rawToken: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(rawToken).digest('hex')
}

/** Parse `nwk_<keyId>_<secret>` format. */
export function parseUserApiKeyToken(
  token: string
): { keyId: string; secret: string } | null {
  if (!token.startsWith('nwk_')) return null
  const parts = token.split('_')
  if (parts.length < 3) return null
  const keyId = parts[1]
  const secret = parts.slice(2).join('_')
  if (!keyId || !secret) return null
  return { keyId, secret }
}

export function isUserApiKeyToken(token: string): boolean {
  return token.startsWith('nwk_')
}

/**
 * Authenticate a Bearer token in `nwk_<id>_<secret>` format.
 * Sets req.userId, req.auth, req.authKind, req.authScopes, req.apiKeyId.
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.header('Authorization')
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null

  if (!token || !isUserApiKeyToken(token)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const parsed = parseUserApiKeyToken(token)
  if (!parsed) {
    res.status(401).json({ error: 'Invalid API key format' })
    return
  }

  try {
    const now = new Date()
    const tokenPrefix = deriveTokenPrefix(token)

    const key = await prisma.userApiKey.findFirst({
      where: {
        id: parsed.keyId,
        tokenPrefix,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: {
        user: {
          select: {
            id: true,
            isActive: true,
            walletAddress: true,
            network: true,
          },
        },
      },
    })

    if (!key) {
      res.status(401).json({ error: 'Invalid or revoked API key' })
      return
    }

    if (key.expiresAt && key.expiresAt <= now) {
      res.status(401).json({ error: 'key_expired' })
      return
    }

    const isMatch = await bcrypt.compare(token, key.hash)
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid or revoked API key' })
      return
    }

    if (!key.user.isActive) {
      res.status(401).json({ error: 'User account is inactive' })
      return
    }

    if (key.ipAllowlist.length > 0) {
      const clientIp = req.ip ?? ''
      if (!key.ipAllowlist.includes(clientIp)) {
        logger.warn('[ApiKeyAuth] IP not in allowlist', {
          keyId: key.id,
          ip: clientIp,
        })
        res.status(403).json({ error: 'IP address not allowed for this key' })
        return
      }
    }

    req.userId = key.user.id
    req.stellarPubKey = key.user.walletAddress
    req.authKind = 'api_key'
    req.authScopes = key.scopes
    req.apiKeyId = key.id
    req.apiKeyAllowWithdrawals = key.allowWithdrawals
    req.auth = {
      userId: key.user.id,
      sessionId: '',
      walletAddress: key.user.walletAddress,
      network: key.user.network,
    }

    prisma.userApiKey
      .update({
        where: { id: key.id },
        data: { lastUsedAt: now, lastUsedIp: req.ip ?? null },
      })
      .catch((err: unknown) =>
        logger.warn('[ApiKeyAuth] Failed to update lastUsedAt', { err })
      )

    next()
  } catch (error) {
    logger.error('[ApiKeyAuth] Middleware error', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Require one or more scopes. Sessions (`authScopes = ['*']`) pass all checks.
 */
export function requireScope(...requiredScopes: UserScope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const scopes = req.authScopes ?? ['*']
    if (scopes.includes('*')) {
      next()
      return
    }

    const granted = requiredScopes.some((s) => scopes.includes(s))
    if (!granted) {
      logger.warn('[ApiKeyAuth] Scope denied', {
        apiKeyId: req.apiKeyId,
        required: requiredScopes[0],
        granted: scopes,
        path: req.originalUrl,
      })
      res.status(403).json({
        error: 'insufficient_scope',
        required: requiredScopes[0],
      })
      return
    }

    next()
  }
}

/**
 * Withdrawal scope guard — API keys need explicit opt-in + platform kill-switch.
 */
export function requireWithdrawScope(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.authKind !== 'api_key') {
    next()
    return
  }

  if (!config.apiKeys.withdrawalsEnabled) {
    res.status(403).json({
      error: 'insufficient_scope',
      required: 'withdraw:write',
      reason: 'API key withdrawals are disabled platform-wide',
    })
    return
  }

  if (!req.apiKeyAllowWithdrawals) {
    res.status(403).json({
      error: 'insufficient_scope',
      required: 'withdraw:write',
      reason: 'This key was not created with withdrawal permission',
    })
    return
  }

  next()
}

/** Keys management and session-only endpoints reject API key auth. */
export function requireSessionAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.authKind === 'api_key') {
    res.status(403).json({ error: 'Session authentication required' })
    return
  }
  next()
}

export function generateUserApiKeyToken(keyId: string, secret: string): string {
  return `nwk_${keyId}_${secret}`
}

export async function hashApiKeyToken(raw: string): Promise<string> {
  return bcrypt.hash(raw, 12)
}

export function deriveApiKeyPrefix(rawToken: string): string {
  return deriveTokenPrefix(rawToken)
}
