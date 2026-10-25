/**
 * Collateral loan lifecycle (#532) — origination, view, and repayment.
 *
 * ─── THE THREE-STEP LIFECYCLE ─────────────────────────────────────────────────
 *
 *   1. ORIGINATE  Lock + pledge + disburse, in ONE database transaction.
 *      The loan row, the ledger Transaction, and the durable outbox op commit
 *      together (#325's guarantee). If the commit fails, nothing is locked and
 *      nothing is owed — there is no window where a user's collateral is
 *      encumbered against a loan that does not exist.
 *
 *   2. ACCRUE  Interest is a pure function of time, recomputed by
 *      src/jobs/loanAccrual.ts. No timer, no interest-bearing row mutation, no
 *      missed-tick problem: two months of downtime produce exactly the same
 *      balance as an hour of uptime.
 *
 *   3. SETTLE  A repayment moves real funds back to the vault through the
 *      outbox, and its effect on the loan is applied when the transfer
 *      CONFIRMS — not when it is submitted. Confirmed-but-unapplied
 *      settlements are swept up by `reconcileLoanSettlements`, which claims
 *      each row with a conditional update so a crash mid-sweep can never
 *      double-apply a repayment.
 *
 * ─── WHY THE LOCK IS NOT A COLUMN ─────────────────────────────────────────────
 * See src/lending/collateralLock.ts: a position is locked exactly when an
 * ACTIVE loan points at it, and the database's partial unique index makes
 * "two loans on one position" impossible rather than merely unlikely.
 *
 * ─── WHAT THIS SERVICE DELIBERATELY DOES NOT DO ───────────────────────────────
 * It never moves money directly. Disbursal and repayment are enqueued as
 * outbox ops and settle through src/outbox/executors.ts, so a loan can never
 * become a back door around the vault's audited write path. Liquidation is the
 * one operation with no Stellar leg (the collateral never leaves the platform)
 * and lives in ./liquidation.ts.
 */

import { Prisma } from '@prisma/client'
import { db } from '../db'
import { config } from '../config/env'
import { AppError } from '../utils/errors'
import { logger } from '../utils/logger'
import { enqueueOutboxOp } from '../outbox/service'
import { dispatchInBackground } from '../outbox/dispatcher'
import { guardOperation, getActivePolicy } from '../approvals/service'
import { assertValidLendingConfig } from './config'
import {
  applyRepayment,
  accruedInterest,
  isWithinLtvCap,
  liquidationDistance,
  maxBorrowable,
  outstandingBalance,
  resolveInterestRateApy,
  worstCaseShortfall,
  currentLtv,
  isLiquidationTriggered,
} from './risk'
import {
  getActiveLoanForPosition,
  listActiveLoansForUser,
} from './collateralLock'
import { accrueInterest } from './accrual'

type Db = typeof db | Prisma.TransactionClient

// The lending book must be provably safe to trade on before a single loan can
// be written. An inverted threshold ordering is a silent, money-losing bug, so
// it aborts the process at load rather than failing later in production.
assertValidLendingConfig(config.lending)

/**
 * The origination LTV cap actually enforced.
 *
 * `maxLtv` is the headline number, but it is additionally bounded by a
 * fraction of the liquidation line: a loan is never originated so close to the
 * threshold that a normal market wobble liquidates it on day one. This is also
 * the single place a future per-protocol (more conservative) threshold plugs
 * in — take the min across every source rather than adding a branch per caller.
 */
export function originationLtvCap(): number {
  return Math.min(
    config.lending.maxLtv,
    config.lending.liquidationLtvThreshold *
      config.lending.maxUnderlyingThresholdFraction
  )
}

// ─── Origination ──────────────────────────────────────────────────────────────

export type OriginationOutcome =
  | {
      status: 'ORIGINATED'
      loanId: string
      transactionId: string
      outboxOpId: string
      principal: number
      interestRateApy: number
      ltvRatio: number
      liquidationLtvThreshold: number
    }
  | {
      status: 'PENDING_APPROVAL'
      requestId: string
      expiresAt: Date
    }

export interface OriginateLoanInput {
  userId: string
  positionId: string
  principal: number
  /** The stablecoin to lend. Defaults to the platform's configured pair. */
  borrowedAsset?: string
  actingAsUserId?: string | null
  /** Set by the approval executor so a replay does not re-enter the guard. */
  skipApprovalGuard?: boolean
}

/**
 * Open a credit line against one deposited position.
 *
 * Order matters here: the approval guard runs FIRST, before the loan row
 * exists. That way a gated origination never leaves a phantom ACTIVE loan
 * holding a lock on a position whose disbursal is still awaiting a co-signer
 * — and a rejected or expired request needs no unlock path at all, because
 * nothing was ever locked.
 */
export async function originateLoan(
  input: OriginateLoanInput
): Promise<OriginationOutcome> {
  const borrowedAsset = (input.borrowedAsset ?? 'USDC').toUpperCase()
  const principal = Number(input.principal)

  if (!Number.isFinite(principal) || principal <= 0) {
    throw new AppError(400, 'Principal must be a positive number')
  }
  if (principal < config.lending.minPrincipal) {
    throw new AppError(
      400,
      `Principal is below the ${config.lending.minPrincipal} ${borrowedAsset} minimum`
    )
  }
  if (principal > config.lending.maxPrincipal) {
    throw new AppError(
      400,
      `Principal is above the ${config.lending.maxPrincipal} ${borrowedAsset} per-loan maximum`
    )
  }

  const position = (await db.position.findUnique({
    where: { id: input.positionId },
    include: { user: { select: { network: true, walletAddress: true } } },
  })) as {
    id: string
    userId: string
    status: string
    currentValue: unknown
    assetSymbol: string
    protocolName: string
    user: { network: string; walletAddress: string }
  } | null

  if (!position || position.userId !== input.userId) {
    throw new AppError(404, 'Position not found')
  }
  if (position.status !== 'ACTIVE') {
    throw new AppError(409, 'Only an active position can back a loan')
  }

  const collateralValue = Number(position.currentValue)
  if (!Number.isFinite(collateralValue)) {
    throw new AppError(
      409,
      'This position has not been valued yet, so no loan can be sized against it'
    )
  }
  if (collateralValue < config.lending.minCollateralValue) {
    throw new AppError(
      400,
      `Collateral is worth ${collateralValue.toFixed(2)} ${position.assetSymbol}; the minimum is ${config.lending.minCollateralValue}`
    )
  }

  const cap = originationLtvCap()
  if (!isWithinLtvCap(principal, collateralValue, cap)) {
    const max = maxBorrowable(collateralValue, cap)
    throw new AppError(
      400,
      `Collateral of ${collateralValue.toFixed(2)} ${position.assetSymbol} supports at most ${max.principal.toFixed(2)} ${borrowedAsset} at a ${(cap * 100).toFixed(0)}% LTV cap`
    )
  }

  if (!input.skipApprovalGuard) {
    // The platform's own ceiling, independent of any user-configured policy:
    // at or above `approvalThreshold` a loan is refused outright unless a
    // BORROW approval policy exists to gate it. This is checked here rather
    // than left to the policy's own thresholds, because guardOperation ALLOWS
    // an operation outright when no policy matches — so a book configured with
    // a high `approvalThreshold` and no BORROW policy would otherwise
    // auto-approve the largest loans it is permitted to originate.
    if (principal >= config.lending.approvalThreshold) {
      const policy = await getActivePolicy(
        input.userId,
        input.actingAsUserId ?? input.userId,
        'BORROW'
      )
      if (!policy) {
        throw new AppError(
          403,
          `Loans of ${config.lending.approvalThreshold} ${borrowedAsset} or more require a co-signer. No active BORROW approval policy is configured for this account, so the request cannot be gated and has been refused.`
        )
      }
    }

    const guard = await guardOperation({
      userId: input.userId,
      actingAsUserId: input.actingAsUserId ?? null,
      permission: 'BORROW',
      amount: principal,
      assetSymbol: borrowedAsset,
      payload: {
        type: 'loan_origination',
        userId: input.userId,
        positionId: input.positionId,
        principal,
        borrowedAsset,
        actingAsUserId: input.actingAsUserId ?? null,
      },
    })

    if (!guard.allowed) {
      logger.info('[Lending] Origination gated pending approval', {
        userId: input.userId,
        positionId: input.positionId,
        principal,
        requestId: guard.requestId,
      })
      return {
        status: 'PENDING_APPROVAL',
        requestId: guard.requestId,
        expiresAt: guard.expiresAt,
      }
    }
  }

  const ltvRatio = principal / collateralValue
  const liquidationLtvThreshold = config.lending.liquidationLtvThreshold
  const rate = await resolveBorrowRate(borrowedAsset, position.user.network)

  const created = await db
    .$transaction(async (tx) => {
      // Re-check inside the transaction. Two concurrent requests can both pass
      // the check above; the partial unique index is what actually settles it,
      // and this read keeps the common case from relying on a constraint error.
      const existing = await tx.collateralLoan.findFirst({
        where: { positionId: input.positionId, status: 'ACTIVE' },
        select: { id: true },
      })
      if (existing) {
        throw new AppError(
          409,
          'This position already has an active loan against it'
        )
      }

      const loan = await tx.collateralLoan.create({
        data: {
          userId: input.userId,
          positionId: input.positionId,
          borrowedAsset,
          principalAmount: principal,
          interestAccrued: 0,
          interestAccruedTo: new Date(),
          underlyingBorrowApy: rate.underlyingBorrowApy,
          platformSpreadApy: rate.platformSpreadApy,
          interestRateApy: rate.interestRateApy,
          ltvRatio,
          liquidationLtvThreshold,
          status: 'ACTIVE',
          lastValuedAt: new Date(),
          lastValuedCollateral: collateralValue,
        },
      })

      const transaction = await tx.transaction.create({
        data: {
          userId: input.userId,
          actingAsUserId: input.actingAsUserId ?? null,
          positionId: input.positionId,
          loanId: loan.id,
          type: 'LOAN_DISBURSE',
          status: 'PENDING',
          assetSymbol: borrowedAsset,
          amount: principal,
          network: position.user.network as never,
          protocolName: position.protocolName,
          memo: `Collateral loan disbursal (loan:${loan.id})`,
        },
      })

      const op = await enqueueOutboxOp(tx, {
        idempotencyKey: `LOAN_DISBURSE:${loan.id}`,
        userId: input.userId,
        kind: 'LOAN_DISBURSE',
        actor: 'SYSTEM',
        payload: {
          method: 'loan_disburse',
          userId: input.userId,
          userAddress: position.user.walletAddress,
          amount: principal,
          assetSymbol: borrowedAsset,
          transactionId: transaction.id,
          loanId: loan.id,
        },
      })

      await tx.collateralLoan.update({
        where: { id: loan.id },
        data: { disburseOutboxOpId: op.id },
      })

      return { loan, transaction, op }
    })
    .catch((err: unknown) => {
      if (err instanceof AppError) throw err
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new AppError(
          409,
          'This position already has an active loan against it'
        )
      }
      throw err
    })

  dispatchInBackground(created.op.id)

  logger.info('[Lending] Loan originated', {
    loanId: created.loan.id,
    userId: input.userId,
    positionId: input.positionId,
    principal,
    borrowedAsset,
    interestRateApy: rate.interestRateApy,
    ltvRatio,
  })

  return {
    status: 'ORIGINATED',
    loanId: created.loan.id,
    transactionId: created.transaction.id,
    outboxOpId: created.op.id,
    principal,
    interestRateApy: rate.interestRateApy,
    ltvRatio,
    liquidationLtvThreshold,
  }
}

// ─── Repayment ────────────────────────────────────────────────────────────────

export type RepaymentOutcome =
  | {
      status: 'REPAYMENT_QUEUED'
      transactionId: string
      outboxOpId: string
      amount: number
      outstandingBefore: number
      willSettleLoan: boolean
    }
  | { status: 'PENDING_APPROVAL'; requestId: string; expiresAt: Date }

/**
 * Queue a repayment. The money leaves the borrower's wallet through the
 * outbox; the loan's balance is only reduced once that transfer confirms.
 */
export async function repayLoan(params: {
  loanId: string
  userId: string
  /** Omit or pass 0 for "everything outstanding right now". */
  amount?: number
  actingAsUserId?: string | null
  skipApprovalGuard?: boolean
}): Promise<RepaymentOutcome> {
  const loan = (await db.collateralLoan.findUnique({
    where: { id: params.loanId },
    include: {
      position: {
        select: { user: { select: { network: true, walletAddress: true } } },
      },
    },
  })) as {
    id: string
    userId: string
    positionId: string
    borrowedAsset: string
    principalAmount: unknown
    interestAccrued: unknown
    interestAccruedTo: Date
    interestRateApy: unknown
    status: string
    position: { user: { network: string; walletAddress: string } }
  } | null

  if (!loan || loan.userId !== params.userId) {
    throw new AppError(404, 'Loan not found')
  }
  if (loan.status !== 'ACTIVE') {
    throw new AppError(409, `This loan is already ${loan.status.toLowerCase()}`)
  }

  const principal = Number(loan.principalAmount)
  const interestAccrued = Number(loan.interestAccrued)
  const rate = Number(loan.interestRateApy)

  // Pay the live balance, not the persisted one: a borrower who has held the
  // loan for a week must be able to clear it in one payment, and the accrual
  // job may not have run since.
  const outstandingBefore = outstandingBalance(
    principal,
    interestAccrued,
    rate,
    loan.interestAccruedTo,
    new Date()
  )

  const requested =
    params.amount === undefined || params.amount === null || params.amount <= 0
      ? outstandingBefore
      : Number(params.amount)

  if (!Number.isFinite(requested) || requested <= 0) {
    throw new AppError(400, 'Repayment amount must be a positive number')
  }
  if (requested > outstandingBefore) {
    throw new AppError(
      400,
      `Amount exceeds the ${outstandingBefore.toFixed(2)} ${loan.borrowedAsset} outstanding on this loan`
    )
  }

  const amount = Math.min(requested, outstandingBefore)

  if (!params.skipApprovalGuard) {
    const guard = await guardOperation({
      userId: params.userId,
      actingAsUserId: params.actingAsUserId ?? null,
      permission: 'BORROW',
      amount,
      assetSymbol: loan.borrowedAsset,
      payload: {
        type: 'loan_repayment',
        userId: params.userId,
        loanId: params.loanId,
        amount,
        actingAsUserId: params.actingAsUserId ?? null,
      },
    })

    if (!guard.allowed) {
      return {
        status: 'PENDING_APPROVAL',
        requestId: guard.requestId,
        expiresAt: guard.expiresAt,
      }
    }
  }

  const willSettleLoan = amount >= outstandingBefore - 1e-9

  const created = await db.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: {
        userId: params.userId,
        actingAsUserId: params.actingAsUserId ?? null,
        positionId: loan.positionId,
        loanId: loan.id,
        type: 'LOAN_REPAYMENT',
        status: 'PENDING',
        assetSymbol: loan.borrowedAsset,
        amount,
        network: loan.position.user.network as never,
        memo: `Collateral loan repayment (loan:${loan.id})`,
      },
    })

    const op = await enqueueOutboxOp(tx, {
      idempotencyKey: `LOAN_REPAYMENT:${loan.id}:${transaction.id}`,
      userId: params.userId,
      kind: 'LOAN_REPAYMENT',
      actor: 'SYSTEM',
      payload: {
        method: 'loan_repayment',
        userId: params.userId,
        userAddress: loan.position.user.walletAddress,
        amount,
        assetSymbol: loan.borrowedAsset,
        transactionId: transaction.id,
        loanId: loan.id,
      },
    })

    return { transaction, op }
  })

  dispatchInBackground(created.op.id)

  logger.info('[Lending] Repayment queued', {
    loanId: loan.id,
    userId: params.userId,
    amount,
    willSettleLoan,
  })

  return {
    status: 'REPAYMENT_QUEUED',
    transactionId: created.transaction.id,
    outboxOpId: created.op.id,
    amount,
    outstandingBefore,
    willSettleLoan,
  }
}

// ─── Settlement reconciliation ───────────────────────────────────────────────

/**
 * Apply confirmed-but-unapplied loan settlements (#532).
 *
 * Why this exists rather than an inline callback in the dispatcher: the
 * dispatcher confirms the Stellar transfer and then mirrors it onto the
 * Transaction row. A process that dies between those two steps leaves a
 * CONFIRMED transfer that the loan has never heard of — the user paid, and
 * the platform still shows them as owing. That window is unavoidable, so
 * recovery has to be a sweep rather than a hook, and the sweep must be
 * crash-safe on its own account.
 *
 * Exactly-once comes from the conditional update: each settlement row is
 * claimed with `updateMany where loanSettlementAppliedAt: null`, so whichever
 * sweep reaches it first wins and every later run sees a no-op.
 *
 * Safe to call at any time; also called at the top of the accrual job tick.
 */
export async function reconcileLoanSettlements(
  options: { limit?: number; now?: Date } = {}
): Promise<{
  repaymentsApplied: number
  disbursesConfirmed: number
  settledLoans: number
}> {
  const limit = options.limit ?? 100
  const now = options.now ?? new Date()

  let repaymentsApplied = 0
  let disbursesConfirmed = 0
  let settledLoans = 0

  // ── Disbursals ─────────────────────────────────────────────────────────────
  // A disbursal needs no balance change — the loan was already ACTIVE when it
  // was written, because the row and the outbox op commit together. All that
  // is outstanding is the exactly-once marker, so a repayment is never
  // reconciled against a loan whose money never actually arrived.
  const pendingDisburses = await db.transaction.findMany({
    where: {
      type: 'LOAN_DISBURSE',
      status: 'CONFIRMED',
      loanId: { not: null },
      loanSettlementAppliedAt: null,
    },
    select: { id: true, loanId: true },
    orderBy: { confirmedAt: 'asc' },
    take: limit,
  })

  for (const row of pendingDisburses) {
    const claimed = await db.transaction.updateMany({
      where: { id: row.id, loanSettlementAppliedAt: null },
      data: { loanSettlementAppliedAt: now },
    })
    if (claimed.count === 1) disbursesConfirmed++
  }

  // ── Repayments ────────────────────────────────────────────────────────────
  const pendingRepayments = await db.transaction.findMany({
    where: {
      type: 'LOAN_REPAYMENT',
      status: 'CONFIRMED',
      loanId: { not: null },
      loanSettlementAppliedAt: null,
    },
    select: { id: true, loanId: true, amount: true },
    orderBy: { confirmedAt: 'asc' },
    take: limit,
  })

  for (const row of pendingRepayments) {
    if (!row.loanId) continue

    const outcome = await applyConfirmedRepayment({
      transactionId: row.id,
      loanId: row.loanId,
      amount: Number(row.amount),
      now,
    })

    if (outcome.applied) {
      repaymentsApplied++
      if (outcome.settled) settledLoans++
    }
  }

  return { repaymentsApplied, disbursesConfirmed, settledLoans }
}

/**
 * Reduce a loan by one confirmed repayment, exactly once.
 *
 * Exported for the test suite because the claim-then-apply ordering is the
 * whole correctness argument and needs to be exercised directly.
 */
export async function applyConfirmedRepayment(params: {
  transactionId: string
  loanId: string
  amount: number
  now?: Date
}): Promise<{ applied: boolean; settled: boolean }> {
  const now = params.now ?? new Date()

  // Claim the settlement row first. If we lose the race we do nothing at all,
  // which is the only way "applied twice" is prevented.
  const claimed = await db.transaction.updateMany({
    where: { id: params.transactionId, loanSettlementAppliedAt: null },
    data: { loanSettlementAppliedAt: now },
  })
  if (claimed.count !== 1) return { applied: false, settled: false }

  const loan = (await db.collateralLoan.findUnique({
    where: { id: params.loanId },
  })) as {
    id: string
    userId: string
    status: string
    principalAmount: unknown
    interestAccrued: unknown
    interestAccruedTo: Date
    interestRateApy: unknown
  } | null

  if (!loan || loan.status !== 'ACTIVE') {
    logger.warn('[Lending] Repayment for a loan that is no longer active', {
      loanId: params.loanId,
      transactionId: params.transactionId,
      status: loan?.status,
    })
    return { applied: true, settled: false }
  }

  // Bring the loan level with the clock first, so the split below allocates
  // against the interest actually owed at settlement time rather than the
  // interest the last accrual tick happened to record.
  const acc = await accrueInterest(loan.id, now)
  const principal = Number(acc.principalAmount)
  const interestAccrued = Number(acc.interestAccrued)

  const split = applyRepayment({
    principal,
    interestAccrued,
    amount: params.amount,
  })

  await db.collateralLoan.update({
    where: { id: loan.id },
    data: {
      principalAmount: split.remainingPrincipal,
      interestAccrued: split.remainingInterest,
      ...(split.settled ? { status: 'REPAID' as const, closedAt: now } : {}),
    },
  })

  logger.info('[Lending] Repayment applied', {
    loanId: loan.id,
    transactionId: params.transactionId,
    amount: params.amount,
    toInterest: split.toInterest,
    toPrincipal: split.toPrincipal,
    remainingPrincipal: split.remainingPrincipal,
    settled: split.settled,
  })

  return { applied: true, settled: split.settled }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export interface LoanView {
  id: string
  status: string
  positionId: string
  protocolName: string
  collateralAssetSymbol: string
  borrowedAsset: string
  principal: number
  interestAccrued: number
  interestAccruedTo: string
  outstanding: number
  interestRateApy: number
  underlyingBorrowApy: number
  platformSpreadApy: number
  collateralValue: number
  ltvRatio: number
  currentLtv: number
  liquidationLtvThreshold: number
  /** 1 = exactly on the liquidation line, 0 = already past it. */
  liquidationDistance: number
  liquidationTriggered: boolean
  maxAdditionalBorrowable: number
  /** Worst case if collateral went to zero tomorrow. */
  worstCaseShortfall: number
  originatedAt: string
  closedAt: string | null
}

/** A single loan, fully valued as of now. Never mutates. */
export async function getLoanView(
  loanId: string,
  userId: string
): Promise<LoanView | null> {
  const loan = (await db.collateralLoan.findFirst({
    where: { id: loanId, userId },
    include: {
      position: {
        select: { protocolName: true, assetSymbol: true, currentValue: true },
      },
    },
  })) as {
    id: string
    status: string
    positionId: string
    borrowedAsset: string
    principalAmount: unknown
    interestAccrued: unknown
    interestAccruedTo: Date
    interestRateApy: unknown
    underlyingBorrowApy: unknown
    platformSpreadApy: unknown
    ltvRatio: unknown
    liquidationLtvThreshold: unknown
    originatedAt: Date
    closedAt: Date | null
    position: {
      protocolName: string
      assetSymbol: string
      currentValue: unknown
    }
  } | null

  if (!loan) return null
  return buildLoanView(loan, new Date())
}

/** Every loan for a user, active first. */
export async function listLoansForUser(
  userId: string,
  options: { includeClosed?: boolean } = {}
): Promise<LoanView[]> {
  const rows = (await db.collateralLoan.findMany({
    where: {
      userId,
      ...(options.includeClosed ? {} : { status: 'ACTIVE' }),
    },
    include: {
      position: {
        select: { protocolName: true, assetSymbol: true, currentValue: true },
      },
    },
    orderBy: [{ status: 'asc' }, { originatedAt: 'desc' }],
  })) as Array<Parameters<typeof buildLoanView>[0]>

  const now = new Date()
  return rows.map((row) => buildLoanView(row, now))
}

/** Shared projection: a loan row plus its position, valued at `now`. */
function buildLoanView(
  loan: {
    id: string
    status: string
    positionId: string
    borrowedAsset: string
    principalAmount: unknown
    interestAccrued: unknown
    interestAccruedTo: Date
    interestRateApy: unknown
    underlyingBorrowApy: unknown
    platformSpreadApy: unknown
    ltvRatio: unknown
    liquidationLtvThreshold: unknown
    originatedAt: Date
    closedAt: Date | null
    position: {
      protocolName: string
      assetSymbol: string
      currentValue: unknown
    }
  },
  now: Date
): LoanView {
  const principal = Number(loan.principalAmount)
  const interestAccrued = Number(loan.interestAccrued)
  const rate = Number(loan.interestRateApy)
  const collateralValue = Number(loan.position.currentValue)
  const threshold = Number(loan.liquidationLtvThreshold)

  const outstanding = outstandingBalance(
    principal,
    interestAccrued,
    rate,
    loan.interestAccruedTo,
    now
  )
  const ltv = currentLtv({ debt: outstanding, collateralValue })
  const active = loan.status === 'ACTIVE'

  const cap = active
    ? maxBorrowable(collateralValue, originationLtvCap()).principal - principal
    : 0

  return {
    id: loan.id,
    status: loan.status,
    positionId: loan.positionId,
    protocolName: loan.position.protocolName,
    collateralAssetSymbol: loan.position.assetSymbol,
    borrowedAsset: loan.borrowedAsset,
    principal,
    interestAccrued,
    interestAccruedTo: loan.interestAccruedTo.toISOString(),
    outstanding,
    interestRateApy: rate,
    underlyingBorrowApy: Number(loan.underlyingBorrowApy),
    platformSpreadApy: Number(loan.platformSpreadApy),
    collateralValue,
    ltvRatio: Number(loan.ltvRatio),
    currentLtv: Number.isFinite(ltv) ? ltv : Number.MAX_SAFE_INTEGER,
    liquidationLtvThreshold: threshold,
    liquidationDistance: liquidationDistance(ltv, threshold),
    liquidationTriggered: active && isLiquidationTriggered(ltv, threshold),
    maxAdditionalBorrowable: Math.max(0, cap),
    worstCaseShortfall: worstCaseShortfall(outstanding, collateralValue),
    originatedAt: loan.originatedAt.toISOString(),
    closedAt: loan.closedAt ? loan.closedAt.toISOString() : null,
  }
}

/**
 * What the user could still borrow against this position, and why that number
 * is what it is. Powers the pre-flight check the UI shows before a request.
 */
export async function getBorrowingCapacity(
  userId: string,
  positionId: string
): Promise<{
  positionId: string
  collateralValue: number
  ltvCap: number
  maxBorrowable: number
  alreadyBorrowed: number
  available: number
  availableAfterInterestBuffer: number
  liquidationLtvThreshold: number
  interestRateApy: number
  blockedReason: string | null
}> {
  const position = (await db.position.findUnique({
    where: { id: positionId },
    include: { user: { select: { network: true } } },
  })) as {
    id: string
    userId: string
    status: string
    currentValue: unknown
    assetSymbol: string
    user: { network: string }
  } | null

  if (!position || position.userId !== userId) {
    throw new AppError(404, 'Position not found')
  }

  const collateralValue = Number(position.currentValue)
  const cap = originationLtvCap()
  const capacity = maxBorrowable(collateralValue, cap)
  const rate = await resolveBorrowRate('USDC', position.user.network)

  const existing = await getActiveLoanForPosition(positionId)
  const alreadyBorrowed = existing
    ? outstandingBalance(
        existing.principal,
        existing.interestAccrued,
        existing.interestRateApy,
        existing.interestAccruedTo,
        new Date()
      )
    : 0

  let blockedReason: string | null = null
  if (position.status !== 'ACTIVE') blockedReason = 'Position is not active'
  else if (existing) blockedReason = 'This position already has an active loan'
  else if (collateralValue < config.lending.minCollateralValue) {
    blockedReason = `Collateral is below the ${config.lending.minCollateralValue} minimum`
  }

  const available = Math.max(0, capacity.principal - alreadyBorrowed)
  const principal = Math.max(0, alreadyBorrowed)

  // A headline "available" figure that ignores future interest over-promises
  // and lands the user just over the liquidation line. Discount the headroom
  // by six months of interest at the rate they would actually be charged.
  const buffer = principal * (rate.interestRateApy / 100) * (182.5 / 365.25)

  return {
    positionId,
    collateralValue,
    ltvCap: cap,
    maxBorrowable: capacity.principal,
    alreadyBorrowed,
    available,
    availableAfterInterestBuffer: Math.max(0, available - buffer),
    liquidationLtvThreshold: config.lending.liquidationLtvThreshold,
    interestRateApy: rate.interestRateApy,
    blockedReason,
  }
}

// ─── Rate resolution ──────────────────────────────────────────────────────────

/**
 * The rate charged on a new loan, snapshotted onto the row at origination.
 *
 * Source of truth is the most recent ProtocolRate row for the asset — the same
 * market data the agent's yield maths reads, so the price of a loan and the
 * price of a strategy are never derived from two different feeds. When the
 * scanner has nothing (brand new asset, adapter outage) we fall back to a
 * configured rate rather than refusing to lend, and the fallback is recorded
 * on the loan so a later audit can tell the two apart.
 */
async function resolveBorrowRate(
  borrowedAsset: string,
  network: string
): Promise<{
  underlyingBorrowApy: number
  platformSpreadApy: number
  interestRateApy: number
}> {
  const platformSpreadApy = config.lending.platformSpreadApy

  const rate = (await db.protocolRate.findFirst({
    where: { assetSymbol: borrowedAsset, network: network as never },
    orderBy: { fetchedAt: 'desc' },
    select: { borrowApy: true },
  })) as { borrowApy: unknown } | null

  const underlyingBorrowApy =
    rate?.borrowApy !== null && rate?.borrowApy !== undefined
      ? Number(rate.borrowApy)
      : config.lending.fallbackBorrowApy

  return {
    underlyingBorrowApy,
    platformSpreadApy,
    interestRateApy: resolveInterestRateApy(
      underlyingBorrowApy,
      platformSpreadApy
    ),
  }
}
