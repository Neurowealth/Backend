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
}

export interface ExecuteDepositResult {
  transaction: Transaction
  status: 'CONFIRMED' | 'FAILED'
}

/**
 * Core deposit logic extracted for reuse by both the HTTP route and the
 * recurring deposit scheduler. Submits an on-chain transaction, persists
 * the Transaction row, and dispatches a webhook on success.
 */
export async function executeDeposit(
  params: ExecuteDepositParams
): Promise<ExecuteDepositResult> {
  const { userId, walletAddress, amount, assetSymbol, memo, actingAsUserId } =
    params

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, network: true },
  })
  if (!user) {
    throw new Error('User not found')
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
      select: { id: true, network: true },
    })
    if (!user) {
      return sendNotFound(res, 'User')
    }

    logger.info('Submitting on-chain withdrawal', {
      correlationId: req.correlationId,
      type,
      userId,
      amount,
      assetSymbol,
    })

    const transaction = await enqueueAndDispatch({
      kind: 'WITHDRAW',
      userId,
      userAddress: req.auth!.walletAddress,
      amount,
      assetSymbol,
      network: user.network,
      type,
      protocolName,
      memo,
      actingAsUserId,
      selectedLotIds,
    })

    logger.info('On-chain withdrawal completed', {
      correlationId: req.correlationId,
      type,
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
          type,
          status: transaction.status,
          assetSymbol,
          amount,
          protocolName,
          userId,
        }
      ).catch(() => {})
    }

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

  return res.status(201).json({
    txHash: result.transaction.txHash,
    status: result.transaction.status,
    transaction: {
      id: result.transaction.id,
      txHash: result.transaction.txHash,
      status: result.transaction.status,
      amount: Number(result.transaction.amount),
      assetSymbol: result.transaction.assetSymbol,
      protocolName: result.transaction.protocolName,
    },
    whatsappReply: formatDepositReply({
      amount: Number(result.transaction.amount),
      assetSymbol: result.transaction.assetSymbol,
      protocolName: result.transaction.protocolName,
    }),
  })
}
