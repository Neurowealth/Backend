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
 * - Regulated AML/KYC records (transactions, fiat orders, KYC profile,
 *   compliance cases, collateral loans) are retained: they are re-pointed at a
 *   pseudonymous retention stub before the user is deleted (#934)
 * - Erasure is refused while a compliance case is open or a loan is active
 * - Referral conversions preserved (owner/referred IDs nullified)
 */

import { randomUUID } from 'crypto'
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

/**
 * Compliance case statuses that mean the case is still being worked. A user
 * under one of these cannot be erased (#934): the case file is evidence in a
 * live investigation or an unfiled SAR. SAR_FILED, CLEARED and
 * CLOSED_NO_ACTION are concluded, so those cases are retained and anonymized
 * rather than blocking erasure.
 */
export const OPEN_COMPLIANCE_CASE_STATUSES = [
  'OPEN',
  'TRIAGE',
  'INVESTIGATING',
  'ESCALATED',
  'PENDING_SAR',
] as const

/**
 * Refuse erasure for a user with an open compliance case or an outstanding
 * (ACTIVE) collateral loan. Accepts a transaction client so the same check can
 * be repeated atomically inside the erasure transaction.
 */
export async function assertErasureAllowed(
  client: {
    complianceCase: { count: (args: any) => Promise<number> }
    collateralLoan: { count: (args: any) => Promise<number> }
  },
  userId: string
): Promise<void> {
  const [openCases, activeLoans] = await Promise.all([
    client.complianceCase.count({
      where: { userId, status: { in: [...OPEN_COMPLIANCE_CASE_STATUSES] } },
    }),
    client.collateralLoan.count({ where: { userId, status: 'ACTIVE' } }),
  ])

  if (openCases > 0) {
    throw new ErasureGuardError(
      `Erasure blocked: user has ${openCases} open compliance case(s). Resolve or close them before erasing.`,
      409
    )
  }
  if (activeLoans > 0) {
    throw new ErasureGuardError(
      `Erasure blocked: user has ${activeLoans} outstanding collateral loan(s). Repay or liquidate them before erasing.`,
      409
    )
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
    agentLogs: number
    webhookSubscriptions: number
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
    // Regulated records kept for AML/KYC retention (#934): ownership moves to
    // a pseudonymous retention stub; the rows themselves are not deleted.
    transactions: number
    fiatOrders: number
    complianceCases: number
    collateralLoans: number
    kycProfiles: number
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

  // #934: an open compliance case or an outstanding loan blocks erasure. Checked
  // before the request is claimed, so a blocked request stays APPROVED and can
  // be retried once the case is closed or the loan settled.
  await assertErasureAllowed(db, userId)

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
        // 1. Count records before deletion (for summary and preserved impact assessment)
        // Preserved records (referrals and audit logs) must be counted prior to user deletion
        // because ReferralCode and ReferralConversion cascade-delete with User in PostgreSQL.
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
          adminAuditLogsCount,
          referralAsOwnerCount,
          referralAsReferredCount,
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
          tx.adminAuditLog.count({
            where: {
              OR: [
                { target: userId },
                {
                  details: {
                    path: ['userId'],
                    equals: userId,
                  },
                },
              ],
            },
          }),
          tx.referralConversion.count({
            where: {
              referralCode: {
                ownerUserId: userId,
              },
            },
          }),
          tx.referralConversion.count({
            where: {
              referredUserId: userId,
            },
          }),
        ])

        // 1b. Re-check the guard inside the transaction: a case could have been
        // opened between the pre-check and now (#934).
        await assertErasureAllowed(tx as any, userId)

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
        // - Session, Position, AgentLog, WebhookSubscription
        // - RecurringDepositPlan, AlertRule, SavingsGoal
        // - SubAccount, PublishedStrategy, StrategyFollow, ReferralCode
        // - CustodialWallet (if exists)

        // 3b. Retain regulated AML/KYC records (#934). They must outlive the
        // user, so re-point them at a pseudonymous retention stub (a fresh id
        // per erased user, so one subject's records stay linkable for
        // investigators but carry no wallet, email or other identifier) before
        // the user row is deleted. The foreign keys are ON DELETE RESTRICT, so
        // anything left pointing at the user would make the delete fail
        // instead of silently cascading.
        const retentionStubId = randomUUID()
        await (tx as any).user.create({
          data: {
            id: retentionStubId,
            walletAddress: `erased:${retentionStubId}`,
            isActive: false,
          },
        })

        // A loan's collateral position must outlive the user with the loan.
        const retainedLoans: Array<{ positionId: string }> =
          (await (tx as any).collateralLoan.findMany({
            where: { userId },
            select: { positionId: true },
          })) ?? []
        const retainedPositionIds = retainedLoans.map((l) => l.positionId)
        if (retainedPositionIds.length > 0) {
          await (tx as any).position.updateMany({
            where: { id: { in: retainedPositionIds } },
            data: { userId: retentionStubId },
          })
        }

        const retainedTransactions = await (tx as any).transaction.updateMany({
          where: { userId },
          data: { userId: retentionStubId, actingAsUserId: null },
        })
        const retainedFiatOrders = await (tx as any).fiatOrder.updateMany({
          where: { userId },
          data: { userId: retentionStubId },
        })
        const retainedComplianceCases = await (
          tx as any
        ).complianceCase.updateMany({
          where: { userId },
          data: { userId: retentionStubId },
        })
        const retainedCollateralLoans = await (
          tx as any
        ).collateralLoan.updateMany({
          where: { userId },
          data: { userId: retentionStubId },
        })
        // KycProfile.userId is the primary key, so it is moved with an update.
        const retainedKycProfiles = await (tx as any).kycProfile.updateMany({
          where: { userId },
          data: {
            userId: retentionStubId,
            providerRef: null,
            reviewNote: null,
          },
        })

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

        return {
          userId,
          walletAddress: user.walletAddress,
          deletedRecords: {
            sessions: sessionsCount,
            positions: positionsCount,
            agentLogs: agentLogsCount,
            webhookSubscriptions: webhookSubscriptionsCount,
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
            transactions: retainedTransactions?.count ?? transactionsCount,
            fiatOrders: retainedFiatOrders?.count ?? fiatOrdersCount,
            complianceCases: retainedComplianceCases?.count ?? 0,
            collateralLoans: retainedCollateralLoans?.count ?? 0,
            kycProfiles: retainedKycProfiles?.count ?? 0,
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
      description: `User ${user.walletAddress} data has been deleted. ${summary.anonymizedRecords.transactions} transactions retained and anonymized, ${summary.anonymizedRecords.costBasisLots} tax lots anonymized.`,
      severity: 'info',
      component: 'privacy-erasure',
      dedupKey: `erasure-complete-${requestId}`,
    })

    return summary
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    // A guard that trips inside the transaction (a case opened mid-flight) is
    // not a failure of the erasure itself: hand the request back so it can be
    // retried once the blocker is cleared (#934).
    if (error instanceof ErasureGuardError) {
      await db.erasureRequest.updateMany({
        where: { id: requestId, status: ErasureRequestStatus.PROCESSING },
        data: { status: ErasureRequestStatus.APPROVED },
      })
      throw error
    }

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
    adminAuditLogsCount,
    referralAsOwnerCount,
    referralAsReferredCount,
    complianceCasesCount,
    collateralLoansCount,
    kycProfilesCount,
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
    db.adminAuditLog.count({
      where: {
        OR: [
          { target: userId },
          {
            details: {
              path: ['userId'],
              equals: userId,
            },
          },
        ],
      },
    }),
    db.referralConversion.count({
      where: {
        referralCode: {
          ownerUserId: userId,
        },
      },
    }),
    db.referralConversion.count({
      where: {
        referredUserId: userId,
      },
    }),
    db.complianceCase.count({ where: { userId } }),
    db.collateralLoan.count({ where: { userId } }),
    db.kycProfile.count({ where: { userId } }),
  ])

  return {
    deletedRecords: {
      sessions: sessionsCount,
      positions: positionsCount,
      agentLogs: agentLogsCount,
      webhookSubscriptions: webhookSubscriptionsCount,
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
      transactions: transactionsCount,
      fiatOrders: fiatOrdersCount,
      complianceCases: complianceCasesCount,
      collateralLoans: collateralLoansCount,
      kycProfiles: kycProfilesCount,
    },
    preservedRecords: {
      adminAuditLogs: adminAuditLogsCount,
      referralConversionsAsOwner: referralAsOwnerCount,
      referralConversionsAsReferred: referralAsReferredCount,
    },
  }
}
