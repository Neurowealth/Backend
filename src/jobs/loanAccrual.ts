/**
 * Loan accrual + settlement reconciliation job (#532).
 *
 * Two responsibilities, run together on one tick because they share a
 * precondition — a loan's balance must be current before anything else
 * reasons about it:
 *
 *   1. RECONCILE. Apply any confirmed repayment the loan has not seen yet.
 *      This runs FIRST, deliberately: a repayment that settled on-chain while
 *      the process was down would otherwise be applied after a liquidation
 *      check that assumed the user still owed the money, and the platform
 *      would sell collateral the user had already paid for.
 *
 *   2. ACCRUE. Bring every active loan's interest level with the clock.
 *
 * Both steps are idempotent and safe to run twice, on two replicas, or by
 * hand — see src/lending/accrual.ts for why the watermark is a
 * compare-and-swap token rather than a timestamp being set.
 *
 * The cadence is a convenience, not a correctness requirement. Because
 * interest is a function of time rather than a running total, a tick that
 * never fires costs nothing; the next one computes the whole elapsed window.
 * The interval is therefore sized for how fresh the numbers in the UI should
 * feel, not for how much interest would be lost.
 */

import { config } from '../config/env'
import { logger } from '../utils/logger'
import { scheduleResilientJob } from './resilientScheduler'
import { accrueAllActiveLoans } from '../lending/accrual'
import { reconcileLoanSettlements } from '../lending/service'

export const LOAN_ACCRUAL_JOB_NAME = 'loan-accrual'

export async function runLoanAccrualTick(): Promise<void> {
  const reconciliation = await reconcileLoanSettlements()
  const accrual = await accrueAllActiveLoans()

  logger.info('[Lending] Accrual tick complete', {
    repaymentsApplied: reconciliation.repaymentsApplied,
    disbursesConfirmed: reconciliation.disbursesConfirmed,
    settledLoans: reconciliation.settledLoans,
    loansProcessed: accrual.processed,
    interestApplied: accrual.totalInterestApplied,
    accrualFailures: accrual.failed,
  })
}

export function scheduleLoanAccrual(): NodeJS.Timeout {
  return scheduleResilientJob({
    jobName: LOAN_ACCRUAL_JOB_NAME,
    task: runLoanAccrualTick,
    intervalMs: config.lending.accrualIntervalMs,
  })
}
