// src/middleware/adminAuth.ts
// #215 – adds granular scope checking per route + audit logging of scope failures
import type { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import db from '../db'
import { logger } from '../utils/logger'
import { recordAuthFailure } from '../utils/metrics'
import type { ScopeDefinition } from '../auth/scopeCatalog'

const prisma = db

// ── Scope enum (#215) ──────────────────────────────────────────────────────

/**
 * Valid admin key scopes — ordered from least to most privileged.
 * A `super` key implicitly includes all other scopes.
 */
export const ADMIN_SCOPES = [
  'support:read',
  'support:write',
  'read',
  'write',
  'wallet',
  'agent',
  'agent:read',
  'agent:write',
  'sessions:read',
  'sessions:write',
  'reserves:read',
  'metrics:read',
  'dlq:read',
  'dlq:write',
  'backfill:write',
  'keys:read',
  'keys:write',
  'fiat:read',
  'fiat:write',
  // #325 — durable outbox admin tooling (list/inspect ops, force-retry FAILED,
  // cancel unsent PENDING ops).
  'outbox:read',
  'outbox:write',
  // #314 — admin cancellation of a PENDING_APPROVAL request (the issue's
  // "requester or admin" cancel rule).
  'approvals:write',
  // #397 — review FLAGGED referral conversions (approve/reject a
  // fraud-heuristic hold) without granting broader write access.
  'referrals:read',
  'referrals:write',
  // #394 — GDPR/CCPA right-to-erasure
  'erasure:write',
  'erasure:read',
  // #494 — feature flags management and staged rollout/rollback
  'flags:read',
  'flags:write',
  // #493 — Telegram and WhatsApp message delivery management & recovery
  'messages:read',
  'messages:write',
  // #528 — treasury sweep policies, emergency sweep, signer rotation.
  'treasury:read',
  'treasury:write',
  // #529 — DB-backed protocol risk metadata review workflow.
  'risk-metadata:read',
  'risk-metadata:write',
  // #548 — admin impersonation: read-only, audited "view as user" support.
  'admin:impersonate',
  'super',
] as const
export type AdminScope = (typeof ADMIN_SCOPES)[number]

/**
 * The admin scopes that grant OTHER scopes rather than gating a route
 * themselves (#615).
 *
 *   super — implies every scope in ADMIN_SCOPES.
 *   agent — the legacy umbrella scope, implying agent:read and agent:write.
 *
 * These are the reason a scope can be "granted" without any route requiring
 * it, so the scope catalogue has to list what each one implies.
 */
export const ADMIN_GRANTOR_SCOPES: Record<
  'super' | 'agent',
  readonly AdminScope[]
> = {
  super: ADMIN_SCOPES,
  agent: ['agent:read', 'agent:write'],
} as const

/**
 * What each admin scope means (#615).
 *
 * Typed as a total map over ADMIN_SCOPES, so a new scope cannot be added
 * without describing it — and the catalogue is what
 * `GET /api/admin/keys/scopes` serves for the key-creation UI.
 */
export const ADMIN_SCOPE_CATALOG: Record<AdminScope, ScopeDefinition> = {
  'support:read': {
    scope: 'support:read',
    enforcement: 'enforced',
    description: 'Read support tickets.',
    risk: 'read',
    grants: 'The support ticket queue and individual tickets.',
  },
  'support:write': {
    scope: 'support:write',
    enforcement: 'enforced',
    description: 'Reply to and update support tickets.',
    risk: 'write',
    grants: 'Replies to and updates customer support tickets.',
  },
  read: {
    scope: 'read',
    enforcement: 'enforced',
    description: 'General read access to admin resources.',
    risk: 'read',
    grants: 'Read-only access across the admin resources the operator names.',
  },
  write: {
    scope: 'write',
    enforcement: 'enforced',
    description: 'General write access to admin resources.',
    risk: 'write',
    grants: 'Mutations across the admin resources the operator names.',
  },
  wallet: {
    scope: 'wallet',
    enforcement: 'declared-only',
    description: 'Custodial wallet operations.',
    risk: 'money',
    grants: 'Reads and rotates custodial wallet key material.',
    requires:
      'No route requires this scope today — the wallet rotation-status ' +
      'route is gated by keys:read. Declared so a key can be provisioned ' +
      'ahead of a route that needs it.',
  },
  agent: {
    scope: 'agent',
    enforcement: 'declared-only',
    description: 'Agent loop operations.',
    risk: 'operational',
    grants: 'The legacy umbrella scope covering agent:read and agent:write.',
    implies: ADMIN_GRANTOR_SCOPES.agent,
  },
  'agent:read': {
    scope: 'agent:read',
    enforcement: 'enforced',
    description: 'Read agent decisions and circuit-breaker state.',
    risk: 'read',
    grants: 'Agent decision history and breaker state.',
  },
  'agent:write': {
    scope: 'agent:write',
    enforcement: 'enforced',
    description: 'Change agent circuit breakers.',
    risk: 'operational',
    grants: 'Resets and reconfigures agent circuit breakers.',
  },
  'sessions:read': {
    scope: 'sessions:read',
    enforcement: 'enforced',
    description: 'Read user sessions.',
    risk: 'read',
    grants: 'The session list for a user.',
  },
  'sessions:write': {
    scope: 'sessions:write',
    enforcement: 'enforced',
    description: 'Revoke user sessions.',
    risk: 'write',
    grants: 'Revokes sessions, including revoking-all for a user.',
  },
  'reserves:read': {
    scope: 'reserves:read',
    enforcement: 'enforced',
    description: 'Read reserve and sponsorship state.',
    risk: 'read',
    grants: 'Reserve balances and sponsorship ledger entries.',
  },
  'metrics:read': {
    scope: 'metrics:read',
    enforcement: 'enforced',
    description: 'Read operational metrics and dashboards.',
    risk: 'read',
    grants: 'Prometheus metrics, job dashboards and audit-chain proofs.',
  },
  'dlq:read': {
    scope: 'dlq:read',
    enforcement: 'enforced',
    description: 'Inspect the dead-letter queue.',
    risk: 'read',
    grants: 'Dead-letter queue contents and inspection reports.',
  },
  'dlq:write': {
    scope: 'dlq:write',
    enforcement: 'enforced',
    description: 'Replay, retry and resolve dead-lettered work.',
    risk: 'operational',
    grants: 'Replays dead-lettered events and marks them resolved.',
  },
  'backfill:write': {
    scope: 'backfill:write',
    enforcement: 'enforced',
    description: 'Run Stellar event backfills.',
    risk: 'operational',
    grants: 'Backfills historical Stellar events.',
  },
  'keys:read': {
    scope: 'keys:read',
    enforcement: 'enforced',
    description: 'Read admin API keys and wallet rotation status.',
    risk: 'read',
    grants: 'The admin key list and wallet key-rotation progress.',
  },
  'keys:write': {
    scope: 'keys:write',
    enforcement: 'enforced',
    description: 'Create, rotate and revoke admin API keys.',
    risk: 'destructive',
    grants: 'Mints new admin credentials and revokes existing ones.',
    requires:
      'Minting an admin key is a takeover vector — every use is written to ' +
      'the admin audit log.',
  },
  'fiat:read': {
    scope: 'fiat:read',
    enforcement: 'enforced',
    description: 'Read fiat providers and their health.',
    risk: 'read',
    grants: 'The configured fiat providers and their failover state.',
  },
  'fiat:write': {
    scope: 'fiat:write',
    enforcement: 'enforced',
    description: 'Change fiat provider failover state.',
    risk: 'operational',
    grants: 'Moves a fiat provider in and out of failover.',
  },
  'outbox:read': {
    scope: 'outbox:read',
    enforcement: 'enforced',
    description: 'Read the durable outbox.',
    risk: 'read',
    grants: 'The outbox queue, per-op detail and queue statistics.',
  },
  'outbox:write': {
    scope: 'outbox:write',
    enforcement: 'enforced',
    description: 'Force-retry and cancel queued outbox operations.',
    risk: 'money',
    grants:
      'Returns a failed op to PENDING, or cancels an unsent one. A ' +
      'force-retry re-submits a real on-chain transaction.',
  },
  'approvals:write': {
    scope: 'approvals:write',
    enforcement: 'enforced',
    description: 'Cancel pending approval requests.',
    risk: 'write',
    grants: 'Cancels a request that is awaiting approval.',
  },
  'referrals:read': {
    scope: 'referrals:read',
    enforcement: 'enforced',
    description: 'Read flagged referral conversions.',
    risk: 'read',
    grants: 'The referral review queue.',
  },
  'referrals:write': {
    scope: 'referrals:write',
    enforcement: 'enforced',
    description: 'Approve or reject flagged referral conversions.',
    risk: 'money',
    grants:
      'Releases or permanently withholds a referral payout. Deliberately ' +
      'narrower than a general write scope so a reviewer cannot reach ' +
      'unrelated state.',
  },
  'erasure:read': {
    scope: 'erasure:read',
    enforcement: 'declared-only',
    description: 'Preview what an erasure would delete.',
    risk: 'read',
    grants: 'A dry run of the data an erasure request would remove.',
    requires:
      'No route requires this scope today — the erasure preview route is ' +
      'gated by the generic read scope. Declared so a key can be ' +
      'provisioned ahead of a route that needs it.',
  },
  'erasure:write': {
    scope: 'erasure:write',
    enforcement: 'enforced',
    description: 'Create, approve, reject and execute erasure requests.',
    risk: 'destructive',
    grants: 'Permanently deletes user data.',
    requires:
      'Execution requires super — approval and execution are deliberately ' +
      'separated so one operator cannot both authorise and carry out a ' +
      'deletion.',
  },
  'flags:read': {
    scope: 'flags:read',
    enforcement: 'enforced',
    description: 'Read feature flags and rollout state.',
    risk: 'read',
    grants: 'Feature flags list, evaluation details and rollback history.',
  },
  'flags:write': {
    scope: 'flags:write',
    enforcement: 'enforced',
    description:
      'Manage feature flags, staged rollouts and emergency rollbacks.',
    risk: 'operational',
    grants:
      'Update runtime overrides, advance staged rollouts, reset flags, and trigger emergency rollbacks.',
  },
  'messages:read': {
    scope: 'messages:read',
    enforcement: 'enforced',
    description: 'Read message delivery state.',
    risk: 'read',
    grants: 'Telegram and WhatsApp delivery state and statistics.',
  },
  'messages:write': {
    scope: 'messages:write',
    enforcement: 'enforced',
    description: 'Retry and recover failed message deliveries.',
    risk: 'operational',
    grants: 'Requeues failed Telegram and WhatsApp deliveries.',
  },
  'treasury:read': {
    scope: 'treasury:read',
    enforcement: 'enforced',
    description: 'Read treasury sweep policies.',
    risk: 'read',
    grants: 'Sweep policies and the emergency-sweep state.',
  },
  'treasury:write': {
    scope: 'treasury:write',
    enforcement: 'enforced',
    description: 'Change treasury sweep policies and run a sweep.',
    risk: 'money',
    grants: 'Moves reserves between treasury tiers on chain.',
    requires:
      'Sweep policies and signer rotations are written to the admin audit log.',
  },
  'risk-metadata:read': {
    scope: 'risk-metadata:read',
    enforcement: 'enforced',
    description: 'Read protocol risk metadata.',
    risk: 'read',
    grants: 'The protocol risk metadata and its review state.',
    requires:
      '`GET /api/v1/admin/risk-metadata` lists entries with a stale flag.',
  },
  'risk-metadata:write': {
    scope: 'risk-metadata:write',
    enforcement: 'enforced',
    description: 'Review and publish protocol risk metadata.',
    risk: 'operational',
    grants: 'Changes the risk metadata other users are shown.',
    requires:
      '`PUT /api/v1/admin/risk-metadata/:protocolName` upserts an entry; each change writes a history row and an admin audit log row.',
  },
  'admin:impersonate': {
    scope: 'admin:impersonate',
    enforcement: 'declared-only',
    description: 'View the API as a user, read-only.',
    risk: 'operational',
    grants: 'A read-only "view as" session for support investigations.',
    requires:
      'No route requires this scope today — the impersonation controller ' +
      'exists but is not yet exposed through the admin API. Every ' +
      'impersonated request is attributed to the operator in the admin ' +
      'audit log.',
  },
  super: {
    scope: 'super',
    enforcement: 'enforced',
    description: 'Every admin scope, including erasure execution.',
    risk: 'destructive',
    grants: 'All other admin scopes, implicitly.',
    implies: ADMIN_GRANTOR_SCOPES.super,
    requires:
      'Held by as few keys as possible: it is a superset of every ' +
      'destructive scope in this catalogue.',
  },
}

export interface AdminAuthContext {
  id: string
  name: string
  role: string
  scopes: string[]
}

/** Validate runtime context before trusting its identity or scopes. */
export function getAdminAuth(res: Response): AdminAuthContext | undefined {
  const auth: unknown = res.locals.adminAuth
  if (!auth || typeof auth !== 'object') return undefined
  const candidate = auth as Partial<AdminAuthContext>
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    typeof candidate.role !== 'string' ||
    !candidate.role.trim() ||
    !Array.isArray(candidate.scopes) ||
    !candidate.scopes.every(
      (scope) =>
        typeof scope === 'string' && ADMIN_SCOPES.includes(scope as AdminScope)
    )
  )
    return undefined
  return candidate as AdminAuthContext
}

/** Generic read/write scopes grant no resource-specific privileges. */
export function hasAdminScope(
  auth: AdminAuthContext,
  scope: AdminScope
): boolean {
  if (auth.scopes.includes(scope)) return true
  // A grantor scope implies the scopes it lists. Driven by
  // ADMIN_GRANTOR_SCOPES so the runtime behaviour and the published
  // catalogue cannot drift apart.
  for (const [grantor, implied] of Object.entries(ADMIN_GRANTOR_SCOPES)) {
    if (
      auth.scopes.includes(grantor as AdminScope) &&
      implied.includes(scope)
    ) {
      return true
    }
  }
  return false
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
  if (Array.isArray(legacyHeader)) return legacyHeader[0]?.trim() || undefined
  if (typeof legacyHeader === 'string') return legacyHeader.trim() || undefined
  return undefined
}

function unauthorized(res: Response): void {
  res
    .status(401)
    .json({ success: false, error: 'Admin authentication required' })
}

function forbidden(res: Response): void {
  res
    .status(403)
    .json({ success: false, error: 'Admin access revoked or expired' })
}

async function logScopeMismatch(
  req: Request,
  auth: AdminAuthContext,
  requiredScope: AdminScope
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminKeyId: auth.id,
        adminName: auth.name,
        adminRole: auth.role,
        action: 'scope_check',
        target: req.originalUrl || req.path,
        result: 'denied',
        details: { requiredScope, grantedScopes: auth.scopes },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        method: req.method,
        path: req.originalUrl || req.path,
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
  next: NextFunction
): Promise<void> {
  const rawToken = getTokenFromRequest(req)

  if (!rawToken) {
    recordAuthFailure(req.path, 'missing_token')
    unauthorized(res)
    return
  }

  try {
    const now = new Date()
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
      matched = {
        id: candidate.id,
        name: candidate.name,
        role: candidate.role,
        scopes: candidate.scopes,
      }
      break
    }

    if (!matched) {
      recordAuthFailure(req.path, 'invalid_token')
      logger.warn('[AdminAuth] Invalid admin token attempt', {
        ip: req.ip,
        path: req.originalUrl || req.path,
        method: req.method,
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
        })
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
 * The symbol under which an admin scope guard records the scope it requires.
 * The admin counterpart of SCOPE_TAG in src/middleware/apiKeyAuth.ts — see
 * that module for why the tag exists.
 */
export const ADMIN_SCOPE_TAG = Symbol.for('neuro.adminScope')

/** An admin scope guard, tagged with the scope it requires. */
export type TaggedAdminScopeGuard = ((
  req: Request,
  res: Response,
  next: NextFunction
) => void) & {
  [ADMIN_SCOPE_TAG]?: AdminScope
}

/** The scope an admin guard requires, or undefined when it is not one. */
export function adminGuardScope(handler: unknown): AdminScope | undefined {
  if (typeof handler !== 'function') return undefined
  return (handler as TaggedAdminScopeGuard)[ADMIN_SCOPE_TAG]
}

/**
 * requireAdminScope(scope)
 *
 * #215 & #517 – Factory that returns a middleware enforcing `scope` on the route.
 * Must be placed AFTER requireAdminAuth in the middleware chain.
 *
 * A key with scope `super` is granted access to all routes.
 * The legacy `agent` scope grants `agent:read` and `agent:write` only.
 * Scope mismatches are written to AdminAuditLog and return 403.
 */
export function requireAdminScope(scope: AdminScope) {
  const guard = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const auth = getAdminAuth(res)

    if (!auth) {
      res
        .status(401)
        .json({ success: false, error: 'Admin authentication required' })
      return
    }

    const scopes = auth.scopes as AdminScope[]
    const hasScope = hasAdminScope(auth, scope)

    if (!hasScope) {
      // #215 – audit log every scope-check failure
      await logScopeMismatch(req, auth, scope)
      logger.warn('[AdminAuth] Scope mismatch', {
        adminId: auth.id,
        requiredScope: scope,
        grantedScopes: scopes,
        path: req.originalUrl || req.path,
      })
      res.status(403).json({
        success: false,
        error: `Admin scope '${scope}' required`,
        reason: `Key '${auth.name}' has scopes [${scopes.join(', ')}]; '${scope}' is not granted.`,
      })
      return
    }

    next()
  }

  ;(guard as TaggedAdminScopeGuard)[ADMIN_SCOPE_TAG] = scope
  return guard as TaggedAdminScopeGuard
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
