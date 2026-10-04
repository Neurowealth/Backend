/**
 * Collateral lock (#532) — the single place that answers "is this user's
 * capital movable right now?".
 *
 * ─── WHY THE LOCK IS DERIVED, NOT A COLUMN ───────────────────────────────────
 * There is no `Position.lockedAt`. A position is locked exactly when an ACTIVE
 * CollateralLoan points at it, so the lock and the debt are the same fact
 * read two ways. That removes a whole class of failure a stored flag would
 * invite: a lock that outlives a settled loan (user can never withdraw), a
 * debt with no lock (collateral gets rebalanced away mid-loan), and the
 * reconciliation job that would be needed to keep the two in step. The
 * database backs the v1 "one active loan per position" rule with a partial
 * unique index, so two concurrent originations cannot both win.
 *
 * Two callers, and only two:
 *   - the agent rebalance loop, which must not move locked capital
 *     (src/agent/loop.ts);
 *   - the withdrawal service, which must refuse to unwind a position that
 *     backs a loan (src/controllers/transaction-controller.ts).
 *
 * Both are service-layer callers on purpose: the withdrawal guard sits inside
 * `executeWithdraw`, so the HTTP route, the approval-workflow replay, and the
 * assistant's withdraw tool are all covered by construction rather than by
 * remembering to add a check somewhere new.
 */

import { Prisma } from '@prisma/client'
import db from '../db'
import { AppError } from '../utils/errors'
import { outstandingBalance } from './risk'

type Db = typeof db | Prisma.TransactionClient

export interface ActiveLoanSummary {
  id: string
  userId: string
  positionId: string
  borrowedAsset: string
  principal: number
  interestAccrued: number
  interestRateApy: number
  interestAccruedTo: Date
  liquidationLtvThreshold: number
}

/** Total owed on a loan as of `asOf`, in stablecoin units. */
export function loanOutstanding(
  loan: ActiveLoanSummary,
  asOf = new Date()
): number {
  return outstandingBalance(
    loan.principal,
    loan.interestAccrued,
    loan.interestRateApy,
    loan.interestAccruedTo,
    asOf
  )
}

function toSummary(loan: {
  id: string
  userId: string
  positionId: string
  borrowedAsset: string
  principalAmount: unknown
  interestAccrued: unknown
  interestRateApy: unknown
  interestAccruedTo: Date
  liquidationLtvThreshold: unknown
}): ActiveLoanSummary {
  return {
    id: loan.id,
    userId: loan.userId,
    positionId: loan.positionId,
    borrowedAsset: loan.borrowedAsset,
    principal: Number(loan.principalAmount),
    interestAccrued: Number(loan.interestAccrued),
    interestRateApy: Number(loan.interestRateApy),
    interestAccruedTo: loan.interestAccruedTo,
    liquidationLtvThreshold: Number(loan.liquidationLtvThreshold),
  }
}

const ACTIVE_LOAN_SELECT = {
  id: true,
  userId: true,
  positionId: true,
  borrowedAsset: true,
  principalAmount: true,
  interestAccrued: true,
  interestRateApy: true,
  interestAccruedTo: true,
  liquidationLtvThreshold: true,
} as const

/**
 * Position ids, out of `positionIds`, that are backing an ACTIVE loan.
 * Returned as a Set so the rebalance loop can filter in O(n) rather than
 * issuing a query per position.
 */
export async function getLockedPositionIds(
  positionIds: string[],
  database: Db = db
): Promise<Set<string>> {
  if (positionIds.length === 0) return new Set()

  const rows = (await database.collateralLoan.findMany({
    where: { positionId: { in: positionIds }, status: 'ACTIVE' },
    select: { positionId: true },
  })) as Array<{ positionId: string }>

  return new Set(rows.map((r) => r.positionId))
}

/** The single ACTIVE loan on a position, or null. v1 allows at most one. */
export async function getActiveLoanForPosition(
  positionId: string,
  database: Db = db
): Promise<ActiveLoanSummary | null> {
  const loan = (await database.collateralLoan.findFirst({
    where: { positionId, status: 'ACTIVE' },
    select: ACTIVE_LOAN_SELECT,
  })) as Parameters<typeof toSummary>[0] | null

  return loan ? toSummary(loan) : null
}

/** Every ACTIVE loan for a user, oldest first. */
export async function listActiveLoansForUser(
  userId: string,
  database: Db = db
): Promise<ActiveLoanSummary[]> {
  const rows = (await database.collateralLoan.findMany({
    where: { userId, status: 'ACTIVE' },
    select: ACTIVE_LOAN_SELECT,
    orderBy: { originatedAt: 'asc' },
  })) as Array<Parameters<typeof toSummary>[0]>

  return rows.map(toSummary)
}

/**
 * Refuse to unwind collateral that backs a loan (#532).
 *
 * Called from `executeWithdraw` before anything is enqueued, so the rejection
 * is a clean 409 with the exact locked amount rather than a partial withdrawal
 * that leaves the loan under-collateralized and the user surprised.
 *
 * The position is matched the same way the withdraw path already scopes it —
 * by user, and by protocol/asset when supplied — so a withdrawal aimed at a
 * protocol the user holds unlocked still goes through untouched.
 */
export async function assertCollateralNotLocked(params: {
  userId: string
  protocolName?: string | null
  assetSymbol?: string | null
  database?: Db
}): Promise<void> {
  const database = params.database ?? db

  const positions = (await database.position.findMany({
    where: {
      userId: params.userId,
      status: 'ACTIVE',
      ...(params.protocolName ? { protocolName: params.protocolName } : {}),
      ...(params.assetSymbol ? { assetSymbol: params.assetSymbol } : {}),
    },
    select: { id: true },
  })) as Array<{ id: string }>

  if (positions.length === 0) return

  const lockedPositionIds = await getLockedPositionIds(
    positions.map((p) => p.id),
    database
  )
  if (lockedPositionIds.size === 0) return

  const loan = (await database.collateralLoan.findFirst({
    where: {
      positionId: { in: Array.from(lockedPositionIds) },
      status: 'ACTIVE',
    },
    select: ACTIVE_LOAN_SELECT,
    orderBy: { originatedAt: 'asc' },
  })) as Parameters<typeof toSummary>[0] | null

  if (!loan) return

  const summary = toSummary(loan)
  const outstanding = loanOutstanding(summary)

  throw new AppError(
    409,
    `${outstanding.toFixed(2)} ${summary.borrowedAsset} is locked as loan collateral. Repay the loan to release this position before withdrawing it.`,
    { loanId: summary.id, positionId: summary.positionId, outstanding }
  )
}
