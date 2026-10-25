import { NextFunction, Request, Response } from 'express'
import { SubAccountPermission } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Parses a client-supplied withdraw amount into a positive finite number.
 *
 * #648 — the middleware used to coerce the amount with `Number(...)`, which
 * yields NaN for a missing or garbage value. Every comparison against NaN is
 * false, so the transaction/daily limit checks silently passed. This helper
 * returns null for anything that is not strictly a positive finite amount so
 * callers can fail closed.
 *
 * Only `number` and `string` inputs are considered: `Number(true) === 1` and
 * `Number([5]) === 5` would otherwise let a non-numeric body slip through.
 */
export function parseWithdrawAmount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return amount
}

/**
 * Factory that returns middleware enforcing a specific sub-account permission.
 *
 * When the authenticated user (req.auth.userId) differs from the target user
 * (req.params.userId or req.body.userId), this middleware looks up an ACTIVE
 * SubAccount row linking them and checks that the required permission is
 * present. On success it sets req.auth.actingAsUserId to the parent's id so
 * downstream controllers can attribute the action.
 *
 * Self-access (parentUserId === childUserId) passes through without a DB
 * lookup, preserving the existing self-access path completely.
 *
 * Must be placed AFTER requireAuth in the middleware chain.
 */
export function requireSubAccountPermission(permission: SubAccountPermission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const targetUserId = req.params.userId ?? req.body?.userId

    // Self-access: no sub-account check needed.
    if (!targetUserId || req.auth.userId === targetUserId) {
      return next()
    }

    // #648 — a delegated WITHDRAW must carry a valid amount, otherwise the
    // transaction/daily limit checks cannot be applied: NaN compares false
    // against every limit and an absent amount skips them entirely. The check
    // lives here (not only in the route schema) so the guarantee does not
    // depend on where the middleware is mounted. An unusable amount is passed
    // down as `undefined`, which the permission check fails closed on.
    const amount =
      permission === 'WITHDRAW'
        ? (parseWithdrawAmount(req.body?.amount) ?? undefined)
        : undefined

    try {
      const result = await checkSubAccountPermission(
        req.auth.userId,
        targetUserId,
        permission,
        amount
      )

      if (!result.allowed) {
        if (result.reason === 'invalid_amount') {
          logger.warn(
            '[SubAccount] Rejected delegated withdraw with bad amount',
            {
              parentUserId: req.auth.userId,
              childUserId: targetUserId,
            }
          )
          res.status(400).json({ error: 'Invalid amount' })
          return
        }

        res
          .status(403)
          .json(
            result.reason === 'no_permission'
              ? { error: 'Forbidden', required: permission }
              : { error: 'Forbidden' }
          )
        return
      }

      // Mark as delegated action — downstream controllers use this for audit.
      req.auth.actingAsUserId = req.auth.userId

      logger.info('[SubAccount] Delegated access granted', {
        parentUserId: req.auth.userId,
        childUserId: targetUserId,
        permission,
      })

      next()
    } catch (error) {
      logger.error('[SubAccount] Middleware error:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}

export type SubAccountPermissionCheck =
  | { allowed: true }
  | {
      allowed: false
      reason: 'no_active_link' | 'no_permission' | 'invalid_amount'
    }

/**
 * The non-HTTP core of requireSubAccountPermission above, so a caller with no
 * Express request/response (the assistant tool registry — #318) can enforce
 * the exact same rule the REST routes do rather than re-implementing it.
 *
 * Self-access (parentUserId === childUserId) is NOT special-cased here —
 * callers that need the self-access shortcut (the HTTP middleware above, the
 * assistant orchestrator) check that before calling this, since "am I acting
 * on my own account" is a decision that belongs to the caller, not this
 * lookup.
 *
 * #648 — for a WITHDRAW the amount is mandatory: a missing or invalid amount
 * fails closed instead of skipping the limit checks, since NaN compares false
 * against every limit and an undefined amount skips them entirely. The
 * permission itself is still checked first, so a caller without the grant
 * gets "no_permission" rather than a hint about the amount.
 */
export async function checkSubAccountPermission(
  parentUserId: string,
  childUserId: string,
  permission: SubAccountPermission,
  amount?: number
): Promise<SubAccountPermissionCheck> {
  const subAccount = await db.subAccount.findUnique({
    where: {
      parentUserId_childUserId: { parentUserId, childUserId },
    },
  })

  if (!subAccount || subAccount.status !== 'ACTIVE') {
    return { allowed: false, reason: 'no_active_link' }
  }

  if (!subAccount.permissions.includes(permission)) {
    return { allowed: false, reason: 'no_permission' }
  }

  if (permission === 'WITHDRAW') {
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
      return { allowed: false, reason: 'invalid_amount' }
    }

    if (
      subAccount.transactionLimit != null &&
      amount > Number(subAccount.transactionLimit)
    )
      return { allowed: false, reason: 'no_permission' }
    if (subAccount.dailyLimit != null) {
      const since = new Date()
      since.setUTCHours(0, 0, 0, 0)
      const spent = await db.transaction.aggregate({
        where: {
          actingAsUserId: parentUserId,
          userId: childUserId,
          type: 'WITHDRAWAL',
          createdAt: { gte: since },
          status: { not: 'FAILED' },
        },
        _sum: { amount: true },
      })
      if (
        Number(spent._sum.amount ?? 0) + amount >
        Number(subAccount.dailyLimit)
      )
        return { allowed: false, reason: 'no_permission' }
    }
  }

  return { allowed: true }
}
