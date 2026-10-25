/**
 * Interest accrual (#532).
 *
 * Interest here is a FUNCTION, not a balance that a timer maintains. A loan
 * carries three numbers — principal, the rate frozen at origination, and a
 * watermark saying "interest was last brought level with this instant" — and
 * everything owed is
 *
 *     interestAccrued + principal * rate * (now - interestAccruedTo) / year
 *
 * The consequences are the whole design:
 *
 *   - A missed tick costs nothing. Ten days with the job down and ten days
 *     with it up produce the same balance, because nothing was ever lost; the
 *     next run simply sees a longer elapsed window.
 *   - Running the job twice in the same window is a no-op, so a retry loop,
 *     two replicas, or a manual re-run are all safe.
 *   - A borrower's bill never depends on when a job happened to fire, which
 *     matters when the alternative is "your interest changes depending on our
 *     uptime".
 *
 * ─── CONCURRENCY ──────────────────────────────────────────────────────────────
 * The watermark doubles as a compare-and-swap token. Two accruals that read
 * the same `interestAccruedTo` both compute a delta for the same window, but
 * only the one whose conditional update matches a row count of 1 may persist
 * it; the loser re-reads and returns the already-correct value. That is why
 * this is an `updateMany` with the old timestamp in the WHERE clause and not
 * an `update` — a plain update would let the second writer double-charge the
 * same window.
 */

import { Prisma } from '@prisma/client'
import { db } from '../db'
import { logger } from '../utils/logger'
import { accruedInterest } from './risk'

type Db = typeof db | Prisma.TransactionClient

export interface AccrualResult {
  loanId: string
  principalAmount: number
  interestAccrued: number
  interestAccruedTo: Date
  /** Interest actually written by THIS call (0 when another writer won). */
  applied: number
}

/**
 * Bring one loan's accrued interest level with `now` and return its
 * principal/interest pair. Idempotent and safe to call concurrently.
 */
export async function accrueInterest(
  loanId: string,
  now: Date = new Date(),
  database: Db = db
): Promise<AccrualResult> {
  const loan = (await database.collateralLoan.findUnique({
    where: { id: loanId },
    select: {
      id: true,
      status: true,
      principalAmount: true,
      interestAccrued: true,
      interestAccruedTo: true,
      interestRateApy: true,
    },
  })) as {
    id: string
    status: string
    principalAmount: unknown
    interestAccrued: unknown
    interestAccruedTo: Date
    interestRateApy: unknown
  } | null

  if (!loan) throw new Error(`Loan ${loanId} not found`)

  const principal = Number(loan.principalAmount)
  const interestAccrued = Number(loan.interestAccrued)
  const rate = Number(loan.interestRateApy)
  const from = loan.interestAccruedTo

  const delta = accruedInterest(principal, rate, from, now)

  // A settled loan keeps its final figures; re-accruing it would quietly add
  // interest to a debt the user has already cleared.
  if (loan.status !== 'ACTIVE') {
    return {
      loanId,
      principalAmount: principal,
      interestAccrued,
      interestAccruedTo: from,
      applied: 0,
    }
  }

  if (delta <= 0) {
    return {
      loanId,
      principalAmount: principal,
      interestAccrued,
      interestAccruedTo: from,
      applied: 0,
    }
  }

  const claimed = await database.collateralLoan.updateMany({
    where: { id: loanId, status: 'ACTIVE', interestAccruedTo: from },
    data: {
      interestAccrued: { increment: delta },
      interestAccruedTo: now,
    },
  })

  if (claimed.count === 1) {
    return {
      loanId,
      principalAmount: principal,
      interestAccrued: interestAccrued + delta,
      interestAccruedTo: now,
      applied: delta,
    }
  }

  // Lost the race: the other writer already advanced the watermark. Re-read
  // and report their numbers rather than adding our delta on top of it.
  const winner = (await database.collateralLoan.findUnique({
    where: { id: loanId },
    select: {
      principalAmount: true,
      interestAccrued: true,
      interestAccruedTo: true,
    },
  })) as {
    principalAmount: unknown
    interestAccrued: unknown
    interestAccruedTo: Date
  }

  return {
    loanId,
    principalAmount: Number(winner.principalAmount),
    interestAccrued: Number(winner.interestAccrued),
    interestAccruedTo: winner.interestAccruedTo,
    applied: 0,
  }
}

/**
 * Accrue across the whole active book. Bounded per tick and errors isolated
 * per loan, so one poisoned row cannot stop the other borrowers from being
 * brought current.
 */
export async function accrueAllActiveLoans(
  options: { now?: Date; limit?: number } = {}
): Promise<{
  processed: number
  totalInterestApplied: number
  failed: number
}> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? 500

  const loans = (await db.collateralLoan.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
    orderBy: { lastValuedAt: 'asc' },
    take: limit,
  })) as Array<{ id: string }>

  let totalInterestApplied = 0
  let failed = 0

  for (const { id } of loans) {
    try {
      const result = await accrueInterest(id, now)
      totalInterestApplied += result.applied
    } catch (err) {
      failed++
      logger.error('[Lending] Accrual failed for loan', {
        loanId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (loans.length > 0 || failed > 0) {
    logger.info('[Lending] Accrual sweep complete', {
      processed: loans.length,
      failed,
      totalInterestApplied,
    })
  }

  return { processed: loans.length, totalInterestApplied, failed }
}
