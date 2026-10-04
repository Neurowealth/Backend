import db from '../db'

type LifecycleDatabase = typeof db

async function changeAlertRuleLifecycle(
  userId: string,
  alertRuleId: string,
  action: 'DELETE' | 'RESTORE',
  database: LifecycleDatabase = db
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const now = new Date()
    const result = await (transaction as any).alertRule.updateMany({
      where: {
        id: alertRuleId,
        userId,
        deletedAt: action === 'DELETE' ? null : { not: null },
      },
      data: { deletedAt: action === 'DELETE' ? now : null },
    })

    if (result.count === 0) return false

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

export function softDeleteAlertRule(
  userId: string,
  alertRuleId: string,
  database: LifecycleDatabase = db
): Promise<boolean> {
  return changeAlertRuleLifecycle(userId, alertRuleId, 'DELETE', database)
}

export function restoreAlertRule(
  userId: string,
  alertRuleId: string,
  database: LifecycleDatabase = db
): Promise<boolean> {
  return changeAlertRuleLifecycle(userId, alertRuleId, 'RESTORE', database)
}
