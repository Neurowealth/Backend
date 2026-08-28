/**
 * Approval-workflow service (#314).
 *
 * A user (or a parent acting on a child via SubAccount delegation) can
 * configure an ApprovalPolicy for WITHDRAW/DEPOSIT/MANAGE_STRATEGY that
 * requires `minApprovers` independent co-signers before an operation above
 * `highValueThreshold` (or every operation, if null) is allowed to execute.
 *
 * Policy resolution: a delegated operation (actingAsUserId !== userId, i.e.
 * a parent acting on a child) resolves the CHILD-scoped policy
 * (principalUserId = the parent, scopedToChildUserId = the child); a
 * self-operation resolves the OWN-account policy (principalUserId = the
 * user, scopedToChildUserId = null). This mirrors how
 * src/middleware/subAccount.ts already distinguishes self-access from
 * delegated access.
 *
 * Eligible approvers: there is no separate "approver list" field on
 * ApprovalPolicy — the issue's schema doesn't define one. This service uses
 * the existing SubAccount graph as the approver pool: the policy's
 * `principalUserId` (the parent, or the user themself for a self-policy)
 * plus every ACTIVE child under that same parent. That is what lets "the
 * parent and a child, or two children" co-sign an operation on a shared
 * vault, per the issue's example, without a schema change.
 *
 * Concurrency: every status transition after PENDING is a conditional
 * `updateMany({ where: { status: 'PENDING' } })`, never read-then-write, so
 * two simultaneous decisions can't double-execute (see `decide` below).
 */
import { Prisma, SubAccountPermission, ApprovalStatus } from '@prisma/client'
import type { ApprovalPolicy, ApprovalRequest } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import db from '../db'
import { logger } from '../utils/logger'
import { AppError } from '../utils/errors'
import { dispatchWebhookEvent } from '../services/webhookDispatcher'
import { getPaginationParams } from '../utils/pagination'
import { runApprovedPayload, type ApprovalPayload } from './executors'

type Db = typeof db | Prisma.TransactionClient

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  )
}

// ─── Policy resolution ─────────────────────────────────────────────────────

export async function getActivePolicy(
  userId: string,
  actingAsUserId: string,
  permission: SubAccountPermission,
  database: Db = db
): Promise<ApprovalPolicy | null> {
  if (actingAsUserId === userId) {
    return database.approvalPolicy.findFirst({
      where: {
        principalUserId: userId,
        scopedToChildUserId: null,
        permission,
        isActive: true,
      },
    })
  }

  return database.approvalPolicy.findFirst({
    where: {
      principalUserId: actingAsUserId,
      scopedToChildUserId: userId,
      permission,
      isActive: true,
    },
  })
}

async function getEligibleApproverIds(
  policy: Pick<ApprovalPolicy, 'principalUserId'>,
  database: Db
): Promise<Set<string>> {
  const ids = new Set<string>([policy.principalUserId])
  const children = await database.subAccount.findMany({
    where: { parentUserId: policy.principalUserId, status: 'ACTIVE' },
    select: { childUserId: true },
  })
  for (const child of children) ids.add(child.childUserId)
  return ids
}

/** True when `userId` is the policy owner or an ACTIVE child of that owner. */
async function canSeeRequestsForPolicyOwner(
  userId: string,
  database: Db
): Promise<string[]> {
  const asChild = await database.subAccount.findMany({
    where: { childUserId: userId, status: 'ACTIVE' },
    select: { parentUserId: true },
  })
  return asChild.map((row) => row.parentUserId)
}

// ─── Guard (entry point from the money path) ──────────────────────────────

export interface GuardOperationParams {
  userId: string // principal whose funds are affected
  actingAsUserId?: string | null // who is requesting; defaults to userId
  permission: SubAccountPermission
  amount: Decimal | number | string
  assetSymbol: string
  payload: ApprovalPayload
  database?: Db
}

export type GuardResult =
  { allowed: true } | { allowed: false; requestId: string; expiresAt: Date }

/**
 * Called from the service layer (executeDeposit/executeWithdraw), never
 * from routes directly, so every entry point that reuses those functions is
 * covered automatically. Returns `{ allowed: true }` immediately (zero
 * friction, unchanged behavior) when no active policy applies or the
 * operation is below the policy's threshold.
 */
export async function guardOperation(
  params: GuardOperationParams
): Promise<GuardResult> {
  const database = params.database ?? db
  const actingAsUserId = params.actingAsUserId ?? params.userId
  const amount = new Decimal(params.amount)

  const policy = await getActivePolicy(
    params.userId,
    actingAsUserId,
    params.permission,
    database
  )
  if (!policy) return { allowed: true }

  const requiresApproval =
    policy.highValueThreshold === null ||
    amount.greaterThanOrEqualTo(policy.highValueThreshold)
  if (!requiresApproval) return { allowed: true }

  // Dedupe: a caller that retries the same logical operation (most notably
  // the recurring-deposit job, which re-evaluates a due plan every sweep)
  // must land on the same open request rather than piling up duplicates —
  // "the requester's intent must never silently vanish" applies just as
  // much to not losing track of it under a new id every retry.
  const existing = await database.approvalRequest.findFirst({
    where: {
      policyId: policy.id,
      userId: params.userId,
      actingAsUserId,
      permission: params.permission,
      assetSymbol: params.assetSymbol,
      amount,
      status: ApprovalStatus.PENDING,
      expiresAt: { gt: new Date() },
    },
  })
  if (existing) {
    return {
      allowed: false,
      requestId: existing.id,
      expiresAt: existing.expiresAt,
    }
  }

  const expiresAt = new Date(Date.now() + policy.approvalTimeoutMs)
  const request = await database.approvalRequest.create({
    data: {
      policyId: policy.id,
      userId: params.userId,
      actingAsUserId,
      permission: params.permission,
      amount,
      assetSymbol: params.assetSymbol,
      payload: params.payload as unknown as Prisma.InputJsonValue,
      minApprovers: policy.minApprovers,
      expiresAt,
    },
  })

  logger.info('[Approvals] Operation gated pending approval', {
    requestId: request.id,
    userId: params.userId,
    actingAsUserId,
    permission: params.permission,
    amount: amount.toString(),
    assetSymbol: params.assetSymbol,
    minApprovers: policy.minApprovers,
  })

  dispatchWebhookEvent('approval.requested', {
    requestId: request.id,
    userId: params.userId,
    actingAsUserId,
    permission: params.permission,
    amount: amount.toString(),
    assetSymbol: params.assetSymbol,
    minApprovers: policy.minApprovers,
    expiresAt: expiresAt.toISOString(),
  }).catch(() => {})

  return { allowed: false, requestId: request.id, expiresAt }
}

// ─── Decisions ─────────────────────────────────────────────────────────────

export interface DecideResult {
  status: ApprovalStatus
  approvalCount?: number
  executionFailed?: boolean
}

export async function decide(
  requestId: string,
  approverUserId: string,
  approved: boolean,
  note: string | undefined,
  database: Db = db
): Promise<DecideResult> {
  const request = await database.approvalRequest.findUnique({
    where: { id: requestId },
    include: { policy: true },
  })
  if (!request) throw new AppError(404, 'Approval request not found')
  if (request.status !== ApprovalStatus.PENDING) {
    throw new AppError(409, `Request is already ${request.status}`)
  }

  const eligible = await getEligibleApproverIds(request.policy, database)
  if (!eligible.has(approverUserId)) {
    throw new AppError(403, 'Not an eligible approver for this request')
  }

  // Self-approval default (issue's documented recommendation): the
  // requester cannot count toward their own multi-signature threshold.
  if (approverUserId === request.actingAsUserId && request.minApprovers > 1) {
    throw new AppError(
      403,
      'Self-approval does not count when more than one approver is required'
    )
  }

  if (!approved) {
    if (!note) throw new AppError(400, 'A reason is required to reject')

    try {
      await database.approval.create({
        data: { requestId, approverUserId, approved: false, note },
      })
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new AppError(
          409,
          'You have already recorded a decision on this request'
        )
      }
      throw err
    }

    const result = await database.approvalRequest.updateMany({
      where: { id: requestId, status: ApprovalStatus.PENDING },
      data: { status: ApprovalStatus.REJECTED, reason: note },
    })
    if (result.count === 0) {
      throw new AppError(409, 'Request is no longer pending')
    }

    dispatchWebhookEvent('approval.rejected', {
      requestId,
      approverUserId,
      reason: note,
    }).catch(() => {})

    return { status: ApprovalStatus.REJECTED }
  }

  try {
    await database.approval.create({
      data: { requestId, approverUserId, approved: true, note },
    })
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new AppError(
        409,
        'You have already recorded a decision on this request'
      )
    }
    throw err
  }

  dispatchWebhookEvent('approval.approved', {
    requestId,
    approverUserId,
  }).catch(() => {})

  const approvalCount = await database.approval.count({
    where: { requestId, approved: true },
  })
  if (approvalCount < request.minApprovers) {
    return { status: ApprovalStatus.PENDING, approvalCount }
  }

  // Threshold crossed. Only the decision that wins this conditional update
  // proceeds to execute — a second approval arriving concurrently (or a
  // racing expiry sweep) will see count === 0 and stop here.
  const claimed = await database.approvalRequest.updateMany({
    where: { id: requestId, status: ApprovalStatus.PENDING },
    data: { status: ApprovalStatus.APPROVED },
  })
  if (claimed.count === 0) {
    return { status: ApprovalStatus.PENDING, approvalCount }
  }

  return executeApprovedRequest(requestId, database)
}

async function executeApprovedRequest(
  requestId: string,
  database: Db
): Promise<DecideResult> {
  const request = await database.approvalRequest.findUnique({
    where: { id: requestId },
  })
  if (!request) return { status: ApprovalStatus.APPROVED }

  try {
    const result = await runApprovedPayload(
      requestId,
      request.payload as unknown as ApprovalPayload
    )

    if (result.status !== 'CONFIRMED' || !result.transaction) {
      // Execution didn't land (on-chain failure). Left APPROVED rather than
      // EXECUTED — that's on-chain finality, so this must stay an
      // ops-visible stuck state for manual retry/investigation, never a
      // silent loss of an approved intent.
      logger.error('[Approvals] Approved request failed to execute', {
        requestId,
        resultStatus: result.status,
      })
      return { status: ApprovalStatus.APPROVED, executionFailed: true }
    }

    await database.approvalRequest.update({
      where: { id: requestId },
      data: {
        status: ApprovalStatus.EXECUTED,
        executedAt: new Date(),
        executedTxId: result.transaction.id,
      },
    })

    dispatchWebhookEvent('approval.executed', {
      requestId,
      transactionId: result.transaction.id,
      txHash: result.transaction.txHash,
    }).catch(() => {})

    return { status: ApprovalStatus.EXECUTED }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[Approvals] Execution threw after approval', {
      requestId,
      error: message,
    })
    return { status: ApprovalStatus.APPROVED, executionFailed: true }
  }
}

// ─── Cancellation ──────────────────────────────────────────────────────────

export async function cancel(
  requestId: string,
  cancelledById: string,
  options: { isAdmin?: boolean } = {},
  database: Db = db
): Promise<{ status: ApprovalStatus }> {
  const request = await database.approvalRequest.findUnique({
    where: { id: requestId },
  })
  if (!request) throw new AppError(404, 'Approval request not found')

  if (
    !options.isAdmin &&
    request.userId !== cancelledById &&
    request.actingAsUserId !== cancelledById
  ) {
    throw new AppError(403, 'Only the requester can cancel this request')
  }

  const result = await database.approvalRequest.updateMany({
    where: { id: requestId, status: ApprovalStatus.PENDING },
    data: { status: ApprovalStatus.CANCELLED, cancelledById },
  })
  if (result.count === 0) {
    throw new AppError(409, `Request is already ${request.status}`)
  }

  dispatchWebhookEvent('approval.cancelled', {
    requestId,
    cancelledById,
  }).catch(() => {})

  return { status: ApprovalStatus.CANCELLED }
}

// ─── Listing ───────────────────────────────────────────────────────────────

export async function listApprovalRequestsForUser(
  userId: string,
  query: { page?: unknown; limit?: unknown },
  database: Db = db
): Promise<{
  requests: ApprovalRequest[]
  page: number
  limit: number
  total: number
}> {
  const { page, limit, skip } = getPaginationParams(query)
  const parentIds = await canSeeRequestsForPolicyOwner(userId, database)

  const where: Prisma.ApprovalRequestWhereInput = {
    OR: [
      { policy: { principalUserId: userId } },
      ...(parentIds.length > 0
        ? [{ policy: { principalUserId: { in: parentIds } } }]
        : []),
    ],
  }

  const [requests, total] = await Promise.all([
    database.approvalRequest.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      skip,
      take: limit,
    }),
    database.approvalRequest.count({ where }),
  ])

  return { requests, page, limit, total }
}

export async function getVisibleRequestDetail(
  requestId: string,
  userId: string,
  database: Db = db
): Promise<(ApprovalRequest & { approvals: unknown[] }) | null> {
  const request = await database.approvalRequest.findUnique({
    where: { id: requestId },
    include: { policy: true, approvals: true },
  })
  if (!request) return null

  const eligible = await getEligibleApproverIds(request.policy, database)
  const visible =
    eligible.has(userId) ||
    request.userId === userId ||
    request.actingAsUserId === userId
  if (!visible) return null

  return request
}
