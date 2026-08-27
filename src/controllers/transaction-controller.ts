import { Request, Response } from 'express'
import { Transaction } from '@prisma/client'
import db from '../db'
import { formatDepositReply, formatWithdrawReply } from '../whatsapp/formatters'
import { sendNotFound, sendUnauthorized } from '../utils/errors'
import { logger } from '../utils/logger'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { enqueueOutboxOp } from '../outbox/service'
import { dispatchOne } from '../outbox/dispatcher'
import { deriveIdempotencyKey } from '../outbox/idempotency'
import { OutboxOpKind } from '../outbox/types'
import { guardOperation } from '../approvals/service'

/**
 * Persist the Transaction row (PENDING, no hash yet) and its outbox intent in
 * the same DB transaction (#325) — "intent persisted" and "business state
 * written" now commit or roll back together, then dispatch it inline so the
 * HTTP/job caller still gets a synchronous CONFIRMED/FAILED result exactly as
 * before this change. If the process crashes between commit and submission,
 * the durable OutboxOp row survives for the background dispatcher
 * (src/outbox/dispatcher.ts) to pick up on the next sweep.
 */
async function enqueueAndDispatch(params: {
  kind: Extract<OutboxOpKind, 'DEPOSIT' | 'WITHDRAW'>
  userId: string
  userAddress: string
  amount: number
  assetSymbol: string
  network: Transaction['network']
  type: 'DEPOSIT' | 'WITHDRAWAL'
  protocolName?: string
  memo?: string
  actingAsUserId?: string | null
  // #317 — SPECIFIC_ID lot selection, WITHDRAWAL only. Captured here so the
  // Stellar event listener has it once the on-chain withdrawal confirms
  // (see src/tax/service.ts's recordDisposalsForWithdrawal).
  selectedLotIds?: string[]
}): Promise<Transaction> {
  const pending = await db.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: {
        userId: params.userId,
        actingAsUserId: params.actingAsUserId ?? null,
        type: params.type,
        status: 'PENDING',
        assetSymbol: params.assetSymbol,
        amount: params.amount,
        network: params.network,
        protocolName: params.protocolName,
        memo: params.memo,
        selectedLotIds: params.selectedLotIds ?? [],
      },
    })

    const op = await enqueueOutboxOp(tx, {
      idempotencyKey: deriveIdempotencyKey(
        params.kind,
        params.userId,
        transaction.id
      ),
      userId: params.userId,
      kind: params.kind,
      actor: 'USER',
      payload:
        params.kind === 'DEPOSIT'
          ? {
              method: 'deposit',
              userId: params.userId,
              userAddress: params.userAddress,
              amount: params.amount,
              assetSymbol: params.assetSymbol,
              transactionId: transaction.id,
            }
          : {
              method: 'withdraw',
              userId: params.userId,
              userAddress: params.userAddress,
              amount: params.amount,
              assetSymbol: params.assetSymbol,
              transactionId: transaction.id,
            },
    })

    return { transaction, opId: op.id }
  })

  try {
    const result = await dispatchOne(pending.opId)
    const succeeded = !result.status || result.status === 'success'
    return db.transaction.update({
      where: { id: pending.transaction.id },
      data: {
        txHash: result.hash,
        status: succeeded ? 'CONFIRMED' : 'FAILED',
        confirmedAt: succeeded ? new Date() : null,
      },
    })
  } catch (err) {
    await db.transaction
      .update({
        where: { id: pending.transaction.id },
        data: { status: 'FAILED' },
      })
      .catch(() => {})
    throw err
  }
}

export interface ExecuteDepositParams {
  userId: string
  walletAddress: string
  amount: number
  assetSymbol: string
  memo?: string
  actingAsUserId?: string | null
  // Set only by src/approvals/executors.ts when re-running an already
  // APPROVED request's payload — never by an HTTP route or job directly, or
  // an approved request would re-trigger guardOperation and gate itself.
  skipApprovalGuard?: boolean
}

export interface ExecuteDepositResult {
  transaction: Transaction | null
  status: 'CONFIRMED' | 'FAILED' | 'PENDING_APPROVAL'
  approvalRequestId?: string
}

/**
 * Core deposit logic extracted for reuse by both the HTTP route and the
 * recurring deposit scheduler. Submits an on-chain transaction, persists
 * the Transaction row, and dispatches a webhook on success.
 *
 * Gated by an ApprovalPolicy (#314) before anything is submitted: this is
 * the single interception point, so the HTTP deposit route AND
 * src/jobs/recurringDeposits.ts (which calls this function directly) are
 * both covered without duplicating the check.
 */
export async function executeDeposit(
  params: ExecuteDepositParams
): Promise<ExecuteDepositResult> {
  const {
    userId,
    walletAddress,
    amount,
    assetSymbol,
    memo,
    actingAsUserId,
    skipApprovalGuard,
  } = params

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, network: true },
  })
  if (!user) {
    throw new Error('User not found')
  }

  if (!skipApprovalGuard) {
    const guard = await guardOperation({
      userId,
      actingAsUserId,
      permission: 'DEPOSIT',
      amount,
      assetSymbol,
      payload: {
        type: 'deposit',
        userId,
        walletAddress,
        amount,
        assetSymbol,
        memo,
        actingAsUserId,
      },
    })
    if (!guard.allowed) {
      return {
        transaction: null,
        status: 'PENDING_APPROVAL',
        approvalRequestId: guard.requestId,
      }
    }
  }

  logger.info('Submitting on-chain deposit', {
    userId,
    amount,
    assetSymbol,
  })

  const transaction = await enqueueAndDispatch({
    kind: 'DEPOSIT',
    userId,
    userAddress: walletAddress,
    amount,
    assetSymbol,
    network: user.network,
    type: 'DEPOSIT',
    memo,
    actingAsUserId,
  })

  logger.info('On-chain deposit completed', {
    userId,
    txHash: transaction.txHash,
    status: transaction.status,
  })

  if (transaction.status === 'CONFIRMED') {
    publishUserEvent(
      userId,
      EVENT_TYPE_TOPIC['transaction.confirmed'],
      'transaction.confirmed',
      {
        txHash: transaction.txHash,
        type: 'DEPOSIT',
        status: transaction.status,
        assetSymbol,
        amount,
        userId,
      }
    ).catch(() => {})
  }

  return {
    transaction,
    status: transaction.status as 'CONFIRMED' | 'FAILED',
  }
}

export interface ExecuteWithdrawParams {
  userId: string
  walletAddress: string
  amount: number
  assetSymbol: string
  protocolName?: string
  memo?: string
  actingAsUserId?: string | null
  // See ExecuteDepositParams.skipApprovalGuard.
  skipApprovalGuard?: boolean
  // #317 — SPECIFIC_ID lot selection, WITHDRAWAL only. Persisted so the
  // Stellar event listener has it when the withdrawal confirms.
  selectedLotIds?: string[]
}

export interface ExecuteWithdrawResult {
  transaction: Transaction | null
  status: 'CONFIRMED' | 'FAILED' | 'PENDING_APPROVAL'
  approvalRequestId?: string
}

/**
 * Core withdrawal logic, mirroring executeDeposit. Extracted so both the
 * HTTP withdraw route and the approval service's post-approval execution
 * path (src/approvals/executors.ts) run through the exact same gate and
 * submission logic.
 */
export async function executeWithdraw(
  params: ExecuteWithdrawParams
): Promise<ExecuteWithdrawResult> {
  const {
    userId,
    walletAddress,
    amount,
    assetSymbol,
    protocolName,
    memo,
    actingAsUserId,
    skipApprovalGuard,
    selectedLotIds,
  } = params

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, network: true },
  })
  if (!user) {
    throw new Error('User not found')
  }

  if (!skipApprovalGuard) {
    const guard = await guardOperation({
      userId,
      actingAsUserId,
      permission: 'WITHDRAW',
      amount,
      assetSymbol,
      payload: {
        type: 'withdraw',
        userId,
        walletAddress,
        amount,
        assetSymbol,
        protocolName,
        memo,
        actingAsUserId,
        selectedLotIds,
      },
    })
    if (!guard.allowed) {
      return {
        transaction: null,
        status: 'PENDING_APPROVAL',
        approvalRequestId: guard.requestId,
      }
    }
  }

  logger.info('Submitting on-chain withdrawal', {
    userId,
    amount,
    assetSymbol,
  })

  const transaction = await enqueueAndDispatch({
    kind: 'WITHDRAW',
    userId,
    userAddress: walletAddress,
    amount,
    assetSymbol,
    network: user.network,
    type: 'WITHDRAWAL',
    protocolName,
    memo,
    actingAsUserId,
    selectedLotIds,
  })

  logger.info('On-chain withdrawal completed', {
    userId,
    txHash: transaction.txHash,
    status: transaction.status,
  })

  if (transaction.status === 'CONFIRMED') {
    publishUserEvent(
      userId,
      EVENT_TYPE_TOPIC['transaction.confirmed'],
      'transaction.confirmed',
      {
        txHash: transaction.txHash,
        type: 'WITHDRAWAL',
        status: transaction.status,
        assetSymbol,
        amount,
        protocolName,
        userId,
      }
    ).catch(() => {})
  }

  return {
    transaction,
    status: transaction.status as 'CONFIRMED' | 'FAILED',
  }
}

export async function processOnChainTransaction(
  req: Request,
  res: Response,
  type: 'DEPOSIT' | 'WITHDRAWAL'
) {
  const { userId, amount, assetSymbol, protocolName, memo, selectedLotIds } =
    req.body

  if (!req.auth) {
    return sendUnauthorized(res)
  }

  // Allow if acting on own behalf OR if this is a verified sub-account delegation
  const isSelf = req.auth.userId === userId
  const isDelegated = req.auth.actingAsUserId !== undefined
  if (!isSelf && !isDelegated) {
    return sendUnauthorized(res)
  }

  const actingAsUserId = req.auth.actingAsUserId ?? null

  if (type === 'WITHDRAWAL') {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) {
      return sendNotFound(res, 'User')
    }

    const result = await executeWithdraw({
      userId,
      walletAddress: req.auth!.walletAddress,
      amount,
      assetSymbol,
      protocolName,
      memo,
      actingAsUserId,
      selectedLotIds,
    })

    if (result.status === 'PENDING_APPROVAL') {
      return res.status(202).json({
        status: 'PENDING_APPROVAL',
        approvalRequestId: result.approvalRequestId,
      })
    }

    const transaction = result.transaction!
    logger.info('On-chain withdrawal completed', {
      correlationId: req.correlationId,
      type,
      userId,
      txHash: transaction.txHash,
      status: transaction.status,
    })

    // Notification already dispatched inside executeWithdraw above — do not
    // re-publish here (that would double-fire transaction.confirmed).
    return res.status(201).json({
      txHash: transaction.txHash,
      status: transaction.status,
      transaction: {
        id: transaction.id,
        txHash: transaction.txHash,
        status: transaction.status,
        amount: Number(transaction.amount),
        assetSymbol: transaction.assetSymbol,
        protocolName: transaction.protocolName,
      },
      whatsappReply: formatWithdrawReply({
        amount: Number(transaction.amount),
        assetSymbol: transaction.assetSymbol,
        protocolName: transaction.protocolName,
      }),
    })
  }

  const result = await executeDeposit({
    userId,
    walletAddress: req.auth!.walletAddress,
    amount,
    assetSymbol,
    memo,
    actingAsUserId,
  })

  if (result.status === 'PENDING_APPROVAL') {
    return res.status(202).json({
      status: 'PENDING_APPROVAL',
      approvalRequestId: result.approvalRequestId,
    })
  }

  const transaction = result.transaction!
  return res.status(201).json({
    txHash: transaction.txHash,
    status: transaction.status,
    transaction: {
      id: transaction.id,
      txHash: transaction.txHash,
      status: transaction.status,
      amount: Number(transaction.amount),
      assetSymbol: transaction.assetSymbol,
      protocolName: transaction.protocolName,
    },
    whatsappReply: formatDepositReply({
      amount: Number(transaction.amount),
      assetSymbol: transaction.assetSymbol,
      protocolName: transaction.protocolName,
    }),
  })
}
