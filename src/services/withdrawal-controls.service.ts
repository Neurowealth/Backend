import db from '../db'
import { StrKey } from '@stellar/stellar-sdk'
import { scoreTransaction, TransactionTypeLike } from '../compliance/scoring'

/** Shared pre-submission checks for HTTP, approved and scheduled withdrawals. */
export async function assessWithdrawal(
  userId: string,
  destinationAddress: string,
  assetSymbol: string,
  amount: number,
  acknowledgeGoalImpact = false
) {
  if (!StrKey.isValidEd25519PublicKey(destinationAddress))
    return { held: true, reason: 'invalid_destination', score: null }
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user || !user.isActive)
    return { held: true, reason: 'compliance_freeze', score: null }
  const activeCase = await db.complianceCase.findFirst({
    where: {
      userId,
      status: {
        in: ['OPEN', 'TRIAGE', 'INVESTIGATING', 'ESCALATED', 'PENDING_SAR'],
      },
    },
  })
  if (activeCase)
    return { held: true, reason: 'compliance_freeze', score: null }

  const history = await db.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  const priorDestinations = await db.outboxOp.findMany({
    where: { userId, kind: 'WITHDRAW', status: 'CONFIRMED' },
    select: { payload: true },
  })
  // Net-worth links are self-reported read-only holdings, not proof that a
  // withdrawal destination has been approved.
  const knownDestinations = [user.walletAddress]
  for (const op of priorDestinations) {
    const payload = op.payload as { userAddress?: string }
    if (payload.userAddress) knownDestinations.push(payload.userAddress)
  }
  const now = new Date()
  const score = scoreTransaction({
    transaction: {
      id: 'withdrawal-preview',
      userId,
      type: 'WITHDRAWAL',
      amount,
      assetSymbol,
      createdAt: now,
      destinationAddress,
      isAgentDriven: false,
    },
    account: {
      userId,
      accountCreatedAt: user.createdAt,
      knownDestinationAddresses: knownDestinations,
      transactionHistory: history
        .filter((t) =>
          [
            'DEPOSIT',
            'WITHDRAWAL',
            'YIELD_CLAIM',
            'REBALANCE',
            'SWAP',
            'REFERRAL_REWARD',
          ].includes(t.type)
        )
        .map((t) => ({
          type: t.type as TransactionTypeLike,
          amount: Number(t.amount),
          assetSymbol: t.assetSymbol,
          createdAt: t.createdAt,
          isAgentDriven: t.type === 'REBALANCE',
        })),
    },
  })
  if (
    !knownDestinations.includes(destinationAddress) ||
    score.totalScore >= 70
  ) {
    return { held: true, reason: 'destination_or_transaction_risk', score }
  }
  const goals = await db.savingsGoal.findMany({
    where: { userId, status: 'ACTIVE' },
  })
  const positions = await db.position.findMany({
    where: { userId, assetSymbol, status: 'ACTIVE' },
  })
  const balance = positions.reduce((sum, p) => sum + Number(p.currentValue), 0)
  if (
    !acknowledgeGoalImpact &&
    goals.some((goal) => balance - amount < Number(goal.targetAmount))
  ) {
    return { held: true, reason: 'goal_guardrail', score }
  }
  return { held: false, reason: null, score }
}
