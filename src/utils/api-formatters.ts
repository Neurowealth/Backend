import type { Transaction, Position } from '@prisma/client'

export const mapTransactionToResponse = (tx: Transaction) => ({
  id: tx.id,
  txHash: tx.txHash,
  type: tx.type,
  status: tx.status,
  amount: Number(tx.amount),
  assetSymbol: tx.assetSymbol,
  protocolName: tx.protocolName,
  createdAt: tx.createdAt.toISOString(),
})

export const mapPositionToResponse = (position: Position) => ({
  id: position.id,
  protocolName: position.protocolName,
  assetSymbol: position.assetSymbol,
  currentValue: Number(position.currentValue),
  yieldEarned: Number(position.yieldEarned),
  status: position.status,
})
