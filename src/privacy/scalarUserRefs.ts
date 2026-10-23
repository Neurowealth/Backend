import { Prisma } from '@prisma/client'

export const DELETED_USER_SENTINEL = '00000000-0000-0000-0000-000000000000'

/**
 * Erases rows in models that reference a user via a scalar id with no Prisma
 * relation, so neither onDelete cascades nor relation cleanup reach them.
 */
export async function eraseScalarUserRefs(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<Record<string, number>> {
  const s = DELETED_USER_SENTINEL
  const where = { userId }
  const counts: Record<string, number> = {}

  counts.IdempotencyRecord = (await tx.idempotencyRecord.deleteMany({ where })).count
  counts.CustodialWallet = (await tx.custodialWallet.deleteMany({ where })).count
  counts.AlertAck = (await tx.alertAck.deleteMany({ where })).count
  counts.NotificationPreferenceAuditLog = (
    await tx.notificationPreferenceAuditLog.deleteMany({ where })
  ).count
  counts.WebAuthnChallenge = (await tx.webAuthnChallenge.deleteMany({ where })).count
  counts.MessageDelivery = (await tx.messageDelivery.deleteMany({ where })).count
  counts.UserEvent = (await tx.userEvent.deleteMany({ where })).count
  counts.UserEventSequence = (await tx.userEventSequence.deleteMany({ where })).count

  counts.LoanLiquidationEvent = (
    await tx.loanLiquidationEvent.updateMany({ where, data: { userId: s } })
  ).count
  counts.PlatformBadDebt = (
    await tx.platformBadDebt.updateMany({ where, data: { userId: s } })
  ).count
  counts.CoverageClaim = (
    await tx.coverageClaim.updateMany({ where, data: { userId: s } })
  ).count
  counts.OutboxOp = (await tx.outboxOp.updateMany({ where, data: { userId: s } })).count
  counts.UserDataAudit =
    (
      await tx.userDataAudit.updateMany({
        where: { tenantUserId: userId },
        data: { tenantUserId: s },
      })
    ).count +
    (
      await tx.userDataAudit.updateMany({
        where: { actorUserId: userId },
        data: { actorUserId: s },
      })
    ).count
  counts.TicketMessage = (
    await tx.ticketMessage.updateMany({
      where: { authorUserId: userId },
      data: { authorUserId: null },
    })
  ).count

  return counts
}
