import { Request, Response } from 'express'
import { Transaction } from '@prisma/client'
import db from '../db'
import { depositForUser, withdrawForUser } from '../stellar/contract'
import { formatDepositReply, formatWithdrawReply } from '../whatsapp/formatters'
import { sendNotFound, sendConflict, sendUnauthorized } from '../utils/errors'
import { logger } from '../utils/logger'
import { dispatchWebhookEvent } from '../services/webhookDispatcher'

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

  const onChainResult = await depositForUser(
    userId,
    walletAddress,
    amount,
    assetSymbol
  )

  logger.info('On-chain deposit completed', {
    userId,
    txHash: onChainResult.hash,
    status: onChainResult.status,
  })

  const transactionStatus =
    onChainResult.status === 'success' ? 'CONFIRMED' : 'FAILED'

  const existing = await db.transaction.findUnique({
    where: { txHash: onChainResult.hash },
    select: { id: true },
  })

  if (existing) {
    throw new Error('Duplicate transaction hash')
  }

  const transaction = await db.transaction.create({
    data: {
      userId,
      actingAsUserId: actingAsUserId ?? null,
      txHash: onChainResult.hash,
      type: 'DEPOSIT',
      status: transactionStatus,
      assetSymbol,
      amount,
      network: user.network,
      memo,
      confirmedAt: transactionStatus === 'CONFIRMED' ? new Date() : null,
    },
  })

  if (transactionStatus === 'CONFIRMED') {
    dispatchWebhookEvent('transaction.confirmed', {
      txHash: transaction.txHash,
      type: 'DEPOSIT',
      status: transaction.status,
      assetSymbol,
      amount,
      userId,
    }).catch(() => {})
  }

  return { transaction, status: transactionStatus }
}

export async function processOnChainTransaction(
  req: Request,
  res: Response,
  type: 'DEPOSIT' | 'WITHDRAWAL'
) {
  const { userId, amount, assetSymbol, protocolName, memo } = req.body

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

    const onChainTransaction = await withdrawForUser(
      userId,
      req.auth!.walletAddress,
      amount,
      assetSymbol
    )

    logger.info('On-chain withdrawal completed', {
      correlationId: req.correlationId,
      type,
      userId,
      txHash: onChainTransaction.hash,
      status: onChainTransaction.status,
    })

    const transactionStatus =
      onChainTransaction.status === 'success' ? 'CONFIRMED' : 'FAILED'

    const existing = await db.transaction.findUnique({
      where: { txHash: onChainTransaction.hash },
      select: { id: true },
    })

    if (existing) {
      return sendConflict(res, 'Duplicate transaction hash')
    }

    const transaction = await db.transaction.create({
      data: {
        userId,
        actingAsUserId,
        txHash: onChainTransaction.hash,
        type,
        status: transactionStatus,
        assetSymbol,
        amount,
        network: user.network,
        protocolName,
        memo,
        confirmedAt: transactionStatus === 'CONFIRMED' ? new Date() : null,
      },
    })

    if (transactionStatus === 'CONFIRMED') {
      dispatchWebhookEvent('transaction.confirmed', {
        txHash: transaction.txHash,
        type,
        status: transaction.status,
        assetSymbol,
        amount,
        protocolName,
        userId,
      }).catch(() => {})
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
