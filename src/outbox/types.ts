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
  | 'ACCOUNT_PROVISION'
  | 'TREASURY_SWEEP'
  | 'LOAN_DISBURSE'
  | 'LOAN_REPAYMENT'
  | 'LOAN_LIQUIDATION'

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
      transactionId: string
      recipientAddress: string
      amount: number
      assetSymbol: string
      conversionId: string
      leg: 'owner' | 'referred' | 'tier2'
    }
  | {
      method: 'sponsor_create_account'
      sponsoredId: string
      sponsorAccount: string
      newAccountId: string
      ledgerKey: string
      xlmReserved: string
    }
  | {
      method: 'sponsor_trustline'
      sponsoredId: string
      sponsorAccount: string
      accountId: string
      assetCode: string
      assetIssuer: string
      ledgerKey: string
      xlmReserved: string
    }
  | {
      method: 'revoke_sponsorship'
      sponsoredId: string
      sponsorAccount: string
      ledgerKey: string
    }
  | {
      method: 'treasury_sweep'
      fromTier: string
      toTier: string
      asset: string
      amount: number
      sweepId: string
    }
  /**
   * #532 — hand borrowed stablecoin to the user. Funds leave the vault, so it
   * settles through the same audited write path as a withdrawal, under its own
   * kind and transaction type: a loan is not a withdrawal and must never be
   * reported as one.
   */
  | {
      method: 'loan_disburse'
      userId: string
      userAddress: string
      amount: number
      assetSymbol: string
      transactionId: string
      loanId: string
    }
  /** #532 — borrowed stablecoin returning to the vault to retire debt. */
  | {
      method: 'loan_repayment'
      userId: string
      userAddress: string
      amount: number
      assetSymbol: string
      transactionId: string
      loanId: string
    }
  /**
   * #532 — protective forced sale of collateral.
   *
   * Deliberately carries NO destination: the collateral never leaves the
   * platform, so the sale is a netting entry (position derecognised, debt
   * retired, remainder to bad debt) rather than a Stellar transfer. The op
   * exists so that action is durable, priority-ordered, retried and
   * observable exactly like every other money movement, and so the executor
   * has one place to perform it. See docs/LENDING.md.
   */
  | {
      method: 'loan_liquidation'
      userId: string
      loanId: string
      positionId: string
      collateralAmount: number
      collateralAssetSymbol: string
      /** Outstanding principal + accrued interest at the moment of the sale. */
      debtOutstanding: number
      borrowedAsset: string
      trigger: 'scheduled' | 'circuit_breaker'
      transactionId: string
      /** Monotonic per loan, so the sale is idempotent under outbox retry. */
      sequence: number
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
  ACCOUNT_PROVISION: 'LOW',
  TREASURY_SWEEP: 'NORMAL',
  // #532 — all three loan legs are CRITICAL. A disbursal is a user waiting on
  // borrowed cash; a repayment is a claim being settled; a liquidation is a
  // protective sale whose recovery decays with every minute it sits behind an
  // agent rebalance.
  LOAN_DISBURSE: 'CRITICAL',
  LOAN_REPAYMENT: 'CRITICAL',
  LOAN_LIQUIDATION: 'CRITICAL',
}
