/**
 * Collateral loan API (#532) — see docs/LENDING.md.
 *
 * ─── ROUTE SURFACE ────────────────────────────────────────────────────────────
 *   GET  /loans                      list the caller's loans
 *   GET  /loans/capacity             what can still be borrowed against a position
 *   GET  /loans/:loanId              one loan, fully valued as of now
 *   POST /loans                      open a credit line against a position
 *   POST /loans/:loanId/repay        return borrowed funds, or clear the loan
 *
 * `/loans/capacity` is declared BEFORE `/loans/:loanId` on purpose: a route
 * matched in declaration order would otherwise read "capacity" as a loan id
 * and 400 on a perfectly valid pre-flight call.
 *
 * Every handler resolves the caller's identity from the authenticated
 * principal and scopes the query to it. There is no `userId` in any request
 * body for a read or a repayment, so a caller cannot address another user's
 * loan by guessing an id — the only userId that ever reaches the service is
 * the one authentication established.
 *
 * Origination and repayment are both irreversible, so they carry the same
 * treatment as a withdrawal: an idempotency key is required, a dedicated rate
 * limit applies, and a sub-account acting for a parent must hold the BORROW
 * permission.
 */

import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { requireScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { requireSubAccountPermission } from '../middleware/subAccount'
import { sensitiveRateLimiter } from '../middleware/rateLimiter'
import { validate } from '../middleware/validate'
import { sendError, sendNotFound } from '../utils/errors'
import { logger } from '../utils/logger'
import {
  borrowingCapacityQuerySchema,
  listLoansQuerySchema,
  loanIdParamSchema,
  originateLoanSchema,
  repayLoanSchema,
} from '../validators/lending-validators'
import {
  getBorrowingCapacity,
  getLoanView,
  listLoansForUser,
  originateLoan,
  repayLoan,
} from '../lending/service'

const router = Router()

// ── GET /loans ────────────────────────────────────────────────────────────────
router.get(
  '/',
  requireAuth,
  requireScope('loans:read'),
  validate({ query: listLoansQuerySchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    const loans = await listLoansForUser(req.auth!.userId, {
      includeClosed:
        (req.query as Record<string, unknown>).includeClosed === true,
    })
    return res.json({ loans, count: loans.length })
  }
)

// ── GET /loans/capacity ───────────────────────────────────────────────────────
// Declared before the :loanId route — see the file header.
router.get(
  '/capacity',
  requireAuth,
  requireScope('loans:read'),
  validate({
    query: borrowingCapacityQuerySchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const { positionId } = req.query as unknown as { positionId: string }
    const capacity = await getBorrowingCapacity(req.auth!.userId, positionId)
    return res.json(capacity)
  }
)

// ── GET /loans/:loanId ────────────────────────────────────────────────────────
router.get(
  '/:loanId',
  requireAuth,
  requireScope('loans:read'),
  validate({ params: loanIdParamSchema, errorMessage: 'Invalid loan ID' }),
  async (req: Request, res: Response) => {
    const { loanId } = req.params as unknown as { loanId: string }
    const loan = await getLoanView(loanId, req.auth!.userId)
    if (!loan) {
      return sendNotFound(res, 'Loan not found')
    }
    return res.json(loan)
  }
)

// ── POST /loans ───────────────────────────────────────────────────────────────
router.post(
  '/',
  requireAuth,
  requireScope('loans:write'),
  // Pledging collateral is irreversible from the caller's side: the position
  // stops being withdrawable the moment this commits.
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  sensitiveRateLimiter,
  validate({ body: originateLoanSchema, errorMessage: 'Validation error' }),
  requireSubAccountPermission('BORROW'),
  async (req: Request, res: Response) => {
    const { positionId, amount, assetSymbol } = req.body as {
      positionId: string
      amount: number
      assetSymbol: string
    }

    const outcome = await originateLoan({
      userId: req.auth!.userId,
      positionId,
      principal: amount,
      borrowedAsset: assetSymbol,
    })

    if (outcome.status === 'PENDING_APPROVAL') {
      return res.status(202).json({
        status: 'PENDING_APPROVAL',
        approvalRequestId: outcome.requestId,
        expiresAt: outcome.expiresAt.toISOString(),
        message:
          'This loan exceeds your approval threshold. It will be opened once the request is approved.',
      })
    }

    return res.status(201).json({
      status: 'ORIGINATED',
      loanId: outcome.loanId,
      transactionId: outcome.transactionId,
      outboxOpId: outcome.outboxOpId,
      principal: outcome.principal,
      interestRateApy: outcome.interestRateApy,
      ltvRatio: outcome.ltvRatio,
      liquidationLtvThreshold: outcome.liquidationLtvThreshold,
      message:
        'Loan opened. The borrowed funds are on their way and your collateral position keeps earning yield.',
    })
  }
)

// ── POST /loans/:loanId/repay ─────────────────────────────────────────────────
router.post(
  '/:loanId/repay',
  requireAuth,
  requireScope('loans:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  sensitiveRateLimiter,
  validate({ params: loanIdParamSchema, errorMessage: 'Invalid loan ID' }),
  validate({ body: repayLoanSchema, errorMessage: 'Validation error' }),
  requireSubAccountPermission('BORROW'),
  async (req: Request, res: Response) => {
    const { loanId } = req.params as unknown as { loanId: string }
    const { amount } = req.body as { amount?: number }

    try {
      const outcome = await repayLoan({
        loanId,
        userId: req.auth!.userId,
        amount,
      })

      if (outcome.status === 'PENDING_APPROVAL') {
        return res.status(202).json({
          status: 'PENDING_APPROVAL',
          approvalRequestId: outcome.requestId,
          expiresAt: outcome.expiresAt.toISOString(),
          message:
            'This repayment exceeds your approval threshold and is waiting for approval.',
        })
      }

      return res.status(202).json({
        status: 'REPAYMENT_QUEUED',
        transactionId: outcome.transactionId,
        outboxOpId: outcome.outboxOpId,
        amount: outcome.amount,
        outstandingBefore: outcome.outstandingBefore,
        willSettleLoan: outcome.willSettleLoan,
        message: outcome.willSettleLoan
          ? 'Full repayment queued. The loan closes and the collateral is released once the transfer confirms.'
          : 'Partial repayment queued. It is applied to the loan once the transfer confirms.',
      })
    } catch (err) {
      // A repayment for a loan that is not the caller's must not be
      // distinguishable from one that does not exist.
      if (err instanceof Error && err.message === 'Loan not found') {
        return sendNotFound(res, 'Loan not found')
      }
      logger.error('[Lending] Repayment failed', {
        loanId,
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to queue repayment')
    }
  }
)

export default router
