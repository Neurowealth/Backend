import db from '../db'

// The database client type, so callers (e.g. tests) can inject their own
// client instead of the shared one
type LifecycleDatabase = typeof db

/**
 * Soft-delete or restore an alert rule and record the change in the audit log.
 * Both steps run in one transaction, so a change is never saved without its
 * audit entry (or the other way around).
 *
 * Soft delete means the row stays in the table with `deletedAt` set; restoring
 * clears it. Returns true if a rule was changed, false if nothing matched
 * (rule not found, not owned by this user, or already in the requested state),
 * in which case no audit entry is written.
 */
async function changeAlertRuleLifecycle(
  userId: string,
  alertRuleId: string,
  action: 'DELETE' | 'RESTORE',
  database: LifecycleDatabase = db
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const now = new Date()
    // `as any` is used because the transaction client's types don't expose
    // these models here
    const result = await (transaction as any).alertRule.updateMany({
      where: {
        id: alertRuleId,
        // Scoping by userId stops a user from touching another user's rules
        userId,
        // Only act on rules in the opposite state: DELETE targets rules that
        // are not yet deleted, RESTORE targets rules that are. This makes both
        // operations safe to repeat.
        deletedAt: action === 'DELETE' ? null : { not: null },
      },
      // DELETE stamps the deletion time; RESTORE clears it
      data: { deletedAt: action === 'DELETE' ? now : null },
    })

    // Nothing matched, so there is nothing to audit
    if (result.count === 0) return false

    // Audit trail of who changed which record and how. The user is both the
    // tenant and the actor, since they can only change their own rules.
    await (transaction as any).userDataAudit.create({
      data: {
        tenantUserId: userId,
        actorUserId: userId,
        recordType: 'AlertRule',
        recordId: alertRuleId,
        action,
      },
    })
    return true
  })
}

/**
 * Soft-delete a user's alert rule (it is hidden, not erased from the table).
 * Returns false if the rule doesn't exist, isn't theirs, or is already deleted.
 */
export function softDeleteAlertRule(
  userId: string,
  alertRuleId: string,
  database: LifecycleDatabase = db
): Promise<boolean> {
  return changeAlertRuleLifecycle(userId, alertRuleId, 'DELETE', database)
}

/**
 * Restore a previously soft-deleted alert rule.
 * Returns false if the rule doesn't exist, isn't theirs, or isn't deleted.
 */
export function restoreAlertRule(
  userId: string,
  alertRuleId: string,
  database: LifecycleDatabase = db
): Promise<boolean> {
  return changeAlertRuleLifecycle(userId, alertRuleId, 'RESTORE', database)
}
