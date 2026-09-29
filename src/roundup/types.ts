import type { RoundUpSettings, RoundUpAccrual, RoundUpAccrualStatus } from '@prisma/client'

/**
 * Result of computing round-up spare change for a purchase.
 */
export interface RoundUpCalculation {
  purchaseAmount: number
  roundToNearest: number
  multiplier: number
  roundUpAmount: number
  totalRoundUp: number
}

/**
 * Aggregated response for round-up accruals.
 */
export interface RoundUpAccrualsResponse {
  unsweptBalance: number
  currency: string
  unsweptCount: number
  accruals: RoundUpAccrual[]
}

/**
 * Result summary of executing a sweep for a user.
 */
export interface SweepExecutionResult {
  userId: string
  totalSwept: number
  accrualCount: number
  status: 'SWEPT' | 'SKIPPED_THRESHOLD' | 'FAILED' | 'PENDING_APPROVAL' | 'NO_WALLET'
  transactionId?: string
  targetGoalId?: string | null
  error?: string
}

export type { RoundUpSettings, RoundUpAccrual, RoundUpAccrualStatus }
