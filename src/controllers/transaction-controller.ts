import { Request, Response } from 'express'
import db from '../db'
import { depositForUser, withdrawForUser } from '../stellar/contract'
import { formatDepositReply, formatWithdrawReply } from '../whatsapp/formatters'
import { sendNotFound, sendConflict } from '../utils/errors'

export async function processOnChainTransaction(
  req: Request,
  res: Response,
  type: 'DEPOSIT' | 'WITHDRAWAL'
) {
  const { userId, amount, assetSymbol, protocolName, memo } = req.body

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, network: true },
  })
  if (!user) {
    return sendNotFound(res, 'User')
  }

  const onChainFn = type === 'DEPOSIT' ? depositForUser : withdrawForUser
  const onChainTransaction = await onChainFn(
    userId,
    req.auth!.walletAddress,
    amount
  )

  const transactionStatus = onChainTransaction.status === 'success' ? 'CONFIRMED' : 'FAILED'

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

  const formatter = type === 'DEPOSIT' ? formatDepositReply : formatWithdrawReply

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
    whatsappReply: formatter({
      amount: Number(transaction.amount),
      assetSymbol: transaction.assetSymbol,
      protocolName: transaction.protocolName,
    }),
  })
}
