/**
 * Privacy Erasure Service (#489)
 *
 * GDPR Article 17 "Right to be Forgotten" implementation. Handles user data
 * deletion requests across all related tables while maintaining audit trail
 * and referential integrity. This is a destructive, irreversible operation
 * that must be carefully validated before execution.
 *
 * Design principles:
 * - Explicit request model (ErasureRequest) tracks approval workflow
 * - Deletion happens in a DB transaction — all or nothing
 * - Audit log preserved even after user deletion (via onDelete: SetNull)
 * - Financial records (tax lots, disposals) anonymized, not deleted
 * - Referral conversions preserved (owner/referred IDs nullified)
 */

import { Prisma } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import { revokeAllUserSessions } from '../services/refresh-token.service'
import { eraseScalarUserRefs } from '../privacy/scalarUserRefs'

export class ErasureGuardError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: 403 | 409 | 422
  ) {
    super(message)
    this.name = 'ErasureGuardError'
  }
}

export function erasureConfirmationPhrase(userId: string): string {
  return `DELETE ${userId}`
}

export enum ErasureRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  PROCESSING = 'PROCESSING',
  REJECTED = 'REJECTED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface ErasureRequest {
  id: string
  userId: string | null
  requestedAt: Date
  requestedBy: string
  reason: string
  status: ErasureRequestStatus
  approvedBy?: string
  approvedAt?: Date
  completedAt?: Date
  errorMessage?: string
}

export interface ErasureSummary {
  userId: string
  walletAddress: string
  deletedRecords: {
    sessions: number
    positions: number
    transactions: number
    agentLogs: number
    webhookSubscriptions: number
    fiatOrders: number
    recurringDepositPlans: number
    alertRules: number
    savingsGoals: number
    subAccountsAsParent: number
    subAccountsAsChild: number
    publishedStrategies: number
    strategyFollows: number
  }
  anonymizedRecords: {
    costBasisLots: number
    lotDisposals: number
    portfolioAttributions: number
  }
  preservedRecords: {
    adminAuditLogs: number
    referralConversionsAsOwner: number
    referralConversionsAsReferred: number
  }
}

/**
 * Create a new erasure request for manual review and approval.
 * Does NOT execute deletion — creates a PENDING request that must be approved.
 */
export async function createErasureRequest(
  userId: string,
  requestedBy: string,
  reason: string
): Promise<ErasureRequest> {
  // Verify user exists
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, walletAddress: true, email: true },
  })

  if (!user) {
    throw new Error(`User ${userId} not found`)
  }

  // Check for existing pending/approved/processing requests
  const existing = await db.erasureRequest.findFirst({
    where: {
      userId,
      status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
    },
  })

  if (existing) {
    throw new Error(
      `Erasure request already exists for user ${userId} with status ${existing.status}`
    )
  }

  let request: any
  try {
    request = await db.erasureRequest.create({
      data: {
        userId,
        requestedBy,
        reason,
        status: ErasureRequestStatus.PENDING,
      },
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const conflict = await db.erasureRequest.findFirst({
        where: {
          userId,
          status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
        },
      })
      const statusStr = conflict?.status ?? 'PENDING'
      throw new Error(
        `Erasure request already exists for user ${userId} with status ${statusStr}`
      )
    }
    throw error
  }

  logger.info('[PrivacyErasure] Erasure request created', {
    requestId: request.id,
    userId,
    requestedBy,
  })

  await alertingService.emit({
    title: 'Privacy erasure request created',
    description: `User ${user.walletAddress} (${user.email ?? 'no email'}) has requested data deletion. Review required.`,
    severity: 'info',
    component: 'privacy-erasure',
    dedupKey: `erasure-request-${request.id}`,
  })

  return request as ErasureRequest
}

/**
 * Approve an erasure request. Does NOT execute deletion — marks ready for execution.
 */
export async function approveErasureRequest(
  requestId: string,
  approvedBy: string
): Promise<ErasureRequest> {
  const request = await db.erasureRequest.findUnique({
    where: { id: requestId },
  })

  if (!request) {
    throw new Error(`Erasure request ${requestId} not found`)
  }

  if (request.status !== ErasureRequestStatus.PENDING) {
    throw new Error(
      `Cannot approve request in status ${request.status}. Must be PENDING.`
    )
  }

  if (request.requestedBy === approvedBy) {
    throw new ErasureGuardError(
      'Self-approval is not allowed: the approver must be a different admin than the requester.',
      403
    )
  }

  const updated = await db.erasureRequest.update({
    where: { id: requestId },
    data: {
      status: ErasureRequestStatus.APPROVED,
      approvedBy,
      approvedAt: new Date(),
    },
  })

  logger.info('[PrivacyErasure] Erasure request approved', {
    requestId,
    approvedBy,
  })

  return updated as ErasureRequest
}

/**
 * Reject an erasure request with a reason.
 */
export async function rejectErasureRequest(
  requestId: string,
  rejectedBy: string,
  rejectionReason: string
): Promise<ErasureRequest> {
  const request = await db.erasureRequest.findUnique({
    where: { id: requestId },
  })

  if (!request) {
    throw new Error(`Erasure request ${requestId} not found`)
  }

  if (request.status !== ErasureRequestStatus.PENDING) {
    throw new Error(
      `Cannot reject request in status ${request.status}. Must be PENDING.`
    )
  }

  const updated = await db.erasureRequest.update({
    where: { id: requestId },
    data: {
      status: ErasureRequestStatus.REJECTED,
      rejectedBy,
      rejectedAt: new Date(),
      rejectionReason,
    },
  })

  logger.info('[PrivacyErasure] Erasure request rejected', {
    requestId,
    rejectedBy,
    reason: rejectionReason,
  })

  return updated as ErasureRequest
}

/**
 * Execute an approved erasure request. Deletes all user data in a transaction.
 * This is irreversible. Only executes if request status is APPROVED.
 */
export async function executeErasure(
  requestId: string,
  executedBy: string,
  confirmation: string | undefined
): Promise<ErasureSummary> {
  const request = await db.erasureRequest.findUnique({
    where: { id: requestId },
    include: { user: true },
  })

  if (!request) {
    throw new Error(`Erasure request ${requestId} not found`)
  }

  if (request.status !== ErasureRequestStatus.APPROVED) {
    throw new Error(
      `Cannot execute request in status ${request.status}. Must be APPROVED.`
    )
  }

  const userId = request.userId
  if (!userId) {
    throw new Error(`User for erasure request ${requestId} not found`)
  }
  const user = request.user

  if (!user || !userId) {
    throw new Error(`User ${userId} not found`)
  }

  if (request.approvedBy === executedBy) {
    throw new ErasureGuardError(
      'Dual control: the admin who approved this request cannot also execute it.',
      403
    )
  }

  if (confirmation !== erasureConfirmationPhrase(userId)) {
    throw new ErasureGuardError(
      `Typed confirmation mismatch. Send confirm: "${erasureConfirmationPhrase(userId)}".`,
      422
    )
  }

  // Claim execution atomically via Compare-And-Set (CAS) transition from APPROVED -> PROCESSING (#684)
  const claimResult = await db.erasureRequest.updateMany({
    where: {
      id: requestId,
      status: ErasureRequestStatus.APPROVED,
    },
    data: {
      status: ErasureRequestStatus.PROCESSING,
    },
  })

  if (claimResult.count === 0) {
    const current = await db.erasureRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    })
    const currentStatus = current?.status ?? 'UNKNOWN'
    throw new Error(
      `Cannot execute request in status ${currentStatus}. Must be APPROVED.`
    )
  }

  try {
    // Cut off live access first so no session can act on or re-create data
    // while the deletion transaction runs.
    await revokeAllUserSessions(userId, 'admin')

    const summary: ErasureSummary = await db.$transaction(
      async (tx) => {
        // 1. Count records before deletion (for summary)
        const [
          sessionsCount,
          positionsCount,
          transactionsCount,
          agentLogsCount,
          webhookSubscriptionsCount,
          fiatOrdersCount,
          recurringDepositPlansCount,
          alertRulesCount,
          savingsGoalsCount,
          subAccountsAsParentCount,
          subAccountsAsChildCount,
          publishedStrategiesCount,
          strategyFollowsCount,
          costBasisLotsCount,
          lotDisposalsCount,
          portfolioAttributionsCount,
        ] = await Promise.all([
          tx.session.count({ where: { userId } }),
          tx.position.count({ where: { userId } }),
          tx.transaction.count({ where: { userId } }),
          tx.agentLog.count({ where: { userId } }),
          tx.webhookSubscription.count({ where: { userId } }),
          tx.fiatOrder.count({ where: { userId } }),
          tx.recurringDepositPlan.count({ where: { userId } }),
          tx.alertRule.count({ where: { userId } }),
          tx.savingsGoal.count({ where: { userId } }),
          tx.subAccount.count({ where: { parentUserId: userId } }),
          tx.subAccount.count({ where: { childUserId: userId } }),
          tx.publishedStrategy.count({ where: { userId } }),
          tx.strategyFollow.count({ where: { followerUserId: userId } }),
          tx.costBasisLot.count({ where: { userId } }),
          tx.lotDisposal.count({ where: { userId } }),
          tx.portfolioAttribution.count({ where: { userId } }),
        ])

        // 2. Anonymize financial records (preserve for regulatory/audit)
        // Tax lots and disposals: set userId to a sentinel "deleted-user" marker
        const DELETED_USER_SENTINEL = '00000000-0000-0000-0000-000000000000'

        await tx.costBasisLot.updateMany({
          where: { userId },
          data: { userId: DELETED_USER_SENTINEL },
        })

        await tx.lotDisposal.updateMany({
          where: { userId },
          data: { userId: DELETED_USER_SENTINEL },
        })

        await tx.portfolioAttribution.updateMany({
          where: { userId },
          data: { userId: DELETED_USER_SENTINEL },
        })

        // 3. Nullify referral foreign keys (preserve conversion records)
        // ReferralCode will cascade-delete (ownerUserId unique)
        // ReferralConversion.referredUserId will cascade-delete OR we nullify
        // depending on whether we want to preserve attribution metrics
        // For now: delete the user's ReferralConversion if they're referred
        // This maintains data integrity while removing PII

        // 4. Delete user and let cascade relationships handle the rest
        // Schema has onDelete: Cascade for most relations:
        // - Session, Position, Transaction, AgentLog, WebhookSubscription
        // - FiatOrder, RecurringDepositPlan, AlertRule, SavingsGoal
        // - SubAccount, PublishedStrategy, StrategyFollow, ReferralCode
        // - CustodialWallet (if exists)

        await eraseScalarUserRefs(tx, userId)

        await (tx as any).user.delete({
          where: { id: userId },
        })

        // Keep the terminal workflow state in the same transaction as deletion.
        await tx.erasureRequest.update({
          where: { id: requestId },
          data: {
            status: ErasureRequestStatus.COMPLETED,
            completedAt: new Date(),
          },
        })

        // 5. Count preserved records (not deleted, just anonymized or nullified)
        const [
          adminAuditLogsCount,
          referralAsOwnerCount,
          referralAsReferredCount,
        ] = await Promise.all([
          tx.adminAuditLog.count({
            where: {
              details: {
                path: ['userId'],
                equals: userId,
              },
            },
          }),
          // ReferralCode cascade-deleted, so conversions via that code are orphaned
          // but still exist with referredUserId intact (unless we anonymize)
          Promise.resolve(0),
          Promise.resolve(0),
        ])

        return {
          userId,
          walletAddress: user.walletAddress,
          deletedRecords: {
            sessions: sessionsCount,
            positions: positionsCount,
            transactions: transactionsCount,
            agentLogs: agentLogsCount,
            webhookSubscriptions: webhookSubscriptionsCount,
            fiatOrders: fiatOrdersCount,
            recurringDepositPlans: recurringDepositPlansCount,
            alertRules: alertRulesCount,
            savingsGoals: savingsGoalsCount,
            subAccountsAsParent: subAccountsAsParentCount,
            subAccountsAsChild: subAccountsAsChildCount,
            publishedStrategies: publishedStrategiesCount,
            strategyFollows: strategyFollowsCount,
          },
          anonymizedRecords: {
            costBasisLots: costBasisLotsCount,
            lotDisposals: lotDisposalsCount,
            portfolioAttributions: portfolioAttributionsCount,
          },
          preservedRecords: {
            adminAuditLogs: adminAuditLogsCount,
            referralConversionsAsOwner: referralAsOwnerCount,
            referralConversionsAsReferred: referralAsReferredCount,
          },
        }
      },
      {
        maxWait: 30000, // 30s
        timeout: 60000, // 60s
      }
    )

    logger.info('[PrivacyErasure] Erasure completed successfully', {
      requestId,
      userId,
      summary,
    })

    await alertingService.emit({
      title: 'Privacy erasure completed',
      description: `User ${user.walletAddress} data has been deleted. ${summary.deletedRecords.transactions} transactions deleted, ${summary.anonymizedRecords.costBasisLots} tax lots anonymized.`,
      severity: 'info',
      component: 'privacy-erasure',
      dedupKey: `erasure-complete-${requestId}`,
    })

    return summary
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    await db.erasureRequest.updateMany({
      where: { id: requestId, status: ErasureRequestStatus.PROCESSING },
      data: {
        status: ErasureRequestStatus.FAILED,
        errorMessage,
      },
    })

    logger.error('[PrivacyErasure] Erasure failed', {
      requestId,
      userId,
      error: errorMessage,
    })

    await alertingService.emit({
      title: 'Privacy erasure failed',
      description: `Failed to delete user ${user.walletAddress} data: ${errorMessage}`,
      severity: 'critical',
      component: 'privacy-erasure',
      dedupKey: `erasure-failed-${requestId}`,
    })

    throw error
  }
}

/**
 * List all erasure requests with optional filtering.
 */
export async function listErasureRequests(params: {
  status?: ErasureRequestStatus
  limit?: number
  offset?: number
}): Promise<{ requests: ErasureRequest[]; total: number }> {
  const { status, limit = 50, offset = 0 } = params

  const where = status ? { status } : {}

  const [requests, total] = await Promise.all([
    db.erasureRequest.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        user: {
          select: {
            walletAddress: true,
            email: true,
            createdAt: true,
          },
        },
      },
    }),
    db.erasureRequest.count({ where }),
  ])

  return { requests: requests as any, total }
}

/**
 * Dry run of an approved erasure request: nothing is deleted or revoked.
 * This is what the execute endpoint returns unless a typed confirmation is sent.
 */
export async function previewErasureRequest(requestId: string): Promise<{
  requestId: string
  userId: string
  requiredConfirmation: string
  preview: Omit<ErasureSummary, 'userId' | 'walletAddress'>
}> {
  const request = await db.erasureRequest.findUnique({
    where: { id: requestId },
  })

  if (!request) {
    throw new Error(`Erasure request ${requestId} not found`)
  }

  if (request.status !== ErasureRequestStatus.APPROVED) {
    throw new Error(
      `Cannot execute request in status ${request.status}. Must be APPROVED.`
    )
  }

  if (!request.userId) {
    throw new Error(`User for erasure request ${requestId} no longer exists`)
  }

  return {
    requestId,
    userId: request.userId,
    requiredConfirmation: erasureConfirmationPhrase(request.userId),
    preview: await previewErasure(request.userId),
  }
}

/**
 * Get a preview of what would be deleted for a user without executing.
 */
export async function previewErasure(
  userId: string
): Promise<Omit<ErasureSummary, 'userId' | 'walletAddress'>> {
  const [
    sessionsCount,
    positionsCount,
    transactionsCount,
    agentLogsCount,
    webhookSubscriptionsCount,
    fiatOrdersCount,
    recurringDepositPlansCount,
    alertRulesCount,
    savingsGoalsCount,
    subAccountsAsParentCount,
    subAccountsAsChildCount,
    publishedStrategiesCount,
    strategyFollowsCount,
    costBasisLotsCount,
    lotDisposalsCount,
    portfolioAttributionsCount,
  ] = await Promise.all([
    db.session.count({ where: { userId } }),
    db.position.count({ where: { userId } }),
    db.transaction.count({ where: { userId } }),
    db.agentLog.count({ where: { userId } }),
    db.webhookSubscription.count({ where: { userId } }),
    db.fiatOrder.count({ where: { userId } }),
    db.recurringDepositPlan.count({ where: { userId } }),
    db.alertRule.count({ where: { userId } }),
    db.savingsGoal.count({ where: { userId } }),
    db.subAccount.count({ where: { parentUserId: userId } }),
    db.subAccount.count({ where: { childUserId: userId } }),
    db.publishedStrategy.count({ where: { userId } }),
    db.strategyFollow.count({ where: { followerUserId: userId } }),
    db.costBasisLot.count({ where: { userId } }),
    db.lotDisposal.count({ where: { userId } }),
    db.portfolioAttribution.count({ where: { userId } }),
  ])

  return {
    deletedRecords: {
      sessions: sessionsCount,
      positions: positionsCount,
      transactions: transactionsCount,
      agentLogs: agentLogsCount,
      webhookSubscriptions: webhookSubscriptionsCount,
      fiatOrders: fiatOrdersCount,
      recurringDepositPlans: recurringDepositPlansCount,
      alertRules: alertRulesCount,
      savingsGoals: savingsGoalsCount,
      subAccountsAsParent: subAccountsAsParentCount,
      subAccountsAsChild: subAccountsAsChildCount,
      publishedStrategies: publishedStrategiesCount,
      strategyFollows: strategyFollowsCount,
    },
    anonymizedRecords: {
      costBasisLots: costBasisLotsCount,
      lotDisposals: lotDisposalsCount,
      portfolioAttributions: portfolioAttributionsCount,
    },
    preservedRecords: {
      adminAuditLogs: 0, // Would need complex query
      referralConversionsAsOwner: 0,
      referralConversionsAsReferred: 0,
    },
  }
}
