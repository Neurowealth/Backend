import { NextFunction, Request, Response } from 'express'
import { SubAccountPermission } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'

// ─── Middleware ───────────────────────────────────────────────────────────────

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

    try {
      const result = await checkSubAccountPermission(
        req.auth.userId,
        targetUserId,
        permission
      )

      if (!result.allowed) {
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
  | { allowed: false; reason: 'no_active_link' | 'no_permission' }

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
 */
export async function checkSubAccountPermission(
  parentUserId: string,
  childUserId: string,
  permission: SubAccountPermission
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

  return { allowed: true }
}
