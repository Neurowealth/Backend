/**
 * Shared types for the durable outbox (#325).
 *
 * Kept free of Prisma/DB imports so src/outbox/stateMachine.ts and
 * src/outbox/priority.ts stay pure and unit-testable without a database.
 */

export type OutboxOpKind =
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'REBALANCE'
  | 'RECURRING_DEPOSIT'
  | 'REFERRAL_REWARD'
  | 'YIELD_CLAIM'

export type OutboxOpActor = 'USER' | 'AGENT' | 'SYSTEM'

export type OutboxPriority = 'CRITICAL' | 'NORMAL' | 'LOW'

export type OutboxOpStatus =
  'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED'

/**
 * The exact, validated operation the dispatcher will submit. Mirrors the
 * arguments the equivalent src/stellar/contract.ts write function already
 * takes — never a key, never raw unvalidated request input.
 */
export type OutboxPayload =
  | {
      method: 'deposit'
      userId: string
      userAddress: string
      amount: number
      assetSymbol: string
      transactionId: string
    }
  | {
      method: 'withdraw'
      userId: string
      userAddress: string
      amount: number
      assetSymbol: string
      transactionId: string
    }
  | {
      method: 'rebalance'
      toProtocol: string
      expectedApyBasisPoints: number
      transactionId: string
    }
  | {
      method: 'referral_reward'
      recipientAddress: string
      amount: number
      assetSymbol: string
      conversionId: string
      leg: 'owner' | 'referred'
    }

export interface OutboxOpRecord {
  id: string
  idempotencyKey: string
  userId: string
  kind: OutboxOpKind
  actor: OutboxOpActor
  payload: OutboxPayload
  priority: OutboxPriority
  status: OutboxOpStatus
  txHash: string | null
  attempts: number
  nextAttemptAt: Date | null
  error: string | null
  submittedAt: Date | null
  confirmedAt: Date | null
  createdAt: Date
  updatedAt: Date
  signerPublicKey: string | null
}

/** Priority classification for each kind, per the #325 design. */
export const PRIORITY_BY_KIND: Record<OutboxOpKind, OutboxPriority> = {
  WITHDRAW: 'CRITICAL',
  DEPOSIT: 'NORMAL',
  RECURRING_DEPOSIT: 'NORMAL',
  REFERRAL_REWARD: 'NORMAL',
  YIELD_CLAIM: 'NORMAL',
  REBALANCE: 'LOW',
}
