export const mapTransactionToResponse = (tx: any) => ({
  id: tx.id,
  txHash: tx.txHash,
  type: tx.type,
  status: tx.status,
  amount: Number(tx.amount),
  assetSymbol: tx.assetSymbol,
  protocolName: tx.protocolName,
  createdAt: tx.createdAt.toISOString(),
})

export const mapPositionToResponse = (position: any) => ({
  id: position.id,
  protocolName: position.protocolName,
  assetSymbol: position.assetSymbol,
  currentValue: Number(position.currentValue),
  yieldEarned: Number(position.yieldEarned),
  status: position.status,
})

export const mapGoalToResponse = (goal: any) => ({
  id: goal.id,
  userId: goal.userId,
  positionId: goal.positionId,
  targetAmount: Number(goal.targetAmount),
  startingAmount: Number(goal.startingAmount),
  targetDate: goal.targetDate.toISOString(),
  riskCeiling: goal.riskCeiling,
  status: goal.status,
  createdAt: goal.createdAt.toISOString(),
  updatedAt: goal.updatedAt.toISOString(),
})
