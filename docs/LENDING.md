/**
 * #532 — collateral loans, in one place.
 *
 * A user deposits a yield-bearing position (XLM in a Soroban pool) and borrows
 * stablecoins against it. The position keeps earning exactly as it did before;
 * what changes is that it can no longer be withdrawn or rebalanced while the
 * loan is live. The borrowed funds are the platform's own working capital, not
 * new money.
 *
 * ─── WHY THE COLLATERAL CANNOT MOVE ────────────────────────────────────────────
 * This is the whole product, so it is worth being explicit about the two
 * failure modes it rules out. If a user could withdraw their collateral
 * mid-loan, the platform would be left holding a debt backed by nothing —
 * lending on the user's honour. If the agent could rebalance a locked position
 * away, the collateral backing an outstanding loan would be silently swapped
 * for a different, differently-valued asset, and the LTV the loan was
 * originated against would stop meaning anything.
 *
 * So the lock is enforced in two places and nowhere else:
 *
 *   - `executeWithdraw` (src/controllers/transaction-controller.ts) — the
 *     service-layer withdrawal path, so the HTTP route, the approval-workflow
 *     replay, and the assistant's withdraw tool are all covered by
 *     construction rather than by remembering to add a check somewhere new;
 *   - the agent rebalance loop (src/agent/loop.ts), which filters locked
 *     positions out of each batch and records a BLOCKED decision explaining
 *     why.
 *
 * A locked position is never silently skipped: the rebalance log carries
 * `blockedReason: 'collateral_locked'` so the omission is auditable.
 *
 * The lock is DERIVED, never stored. A position is locked exactly when an
 * ACTIVE `CollateralLoan` points at it, so the lock and the debt are the same
 * fact read two ways. That removes an entire class of bug a `lockedAt` column
 * would invite — a lock outliving a settled loan, a debt with no lock, and the
 * reconciliation job needed to keep the two in step. Repaying a loan releases
 * the collateral immediately, with nothing to clean up.
 *
 * ─── WHAT HAPPENS WHEN A LOAN GOES BAD ─────────────────────────────────────────
 * The monitor values every active loan against its own FROZEN liquidation
 * threshold. Below it, nothing happens — the position keeps earning yield,
 * which is the entire point. At or over it, a protective sale is enqueued.
 *
 * That sale is the only money movement in the product that a user never
 * authorised, and it is treated accordingly. It goes through the outbox like
 * every other money movement: durable before it happens, CRITICAL priority
 * ahead of agent rebalances, retried on failure, visible in the queue, and
 * reconciled against an idempotency key. It notifies the user on their stream
 * and by webhook, and raises a `critical` alert when the collateral cannot
 * cover the debt.
 *
 * A liquidation is a NETTING entry, not a Stellar transaction: the collateral
 * already sits in the platform's own vault, so the sale moves no funds between
 * wallets. Its identifier is `platform:liquidation:<loanId>:<sequence>`,
 * deliberately not 64 hex characters, so nothing downstream can mistake it for
 * an on-chain fact and go looking for a payment that does not exist.
 *
 * ─── ENDPOINTS ─────────────────────────────────────────────────────────────────
 * Mounted at `/api/loans` in src/index.ts, every route behind
 * `requireAuth`:
 *
 *   GET  /loans?includeClosed=false       the caller's loans
 *   GET  /loans/capacity?positionId=…    what can still be borrowed
 *   GET  /loans/:loanId                  one loan, valued as of now
 *   POST /loans                          originate against a position
 *   POST /loans/:loanId/repay            repay, or settle in full
 *
 * `/loans/capacity` is declared BEFORE `/loans/:loanId` on purpose: routes match
 * in declaration order, so otherwise the literal path "capacity" would be read
 * as a loan id and 400 on a valid pre-flight call.
 *
 * No request body on any route carries a `userId`. The only user id that ever
 * reaches the service is the one `req.auth` established, so a caller cannot
 * address another user's loan by guessing an id — and a loan that is not the
 * caller's returns the same 404 as one that does not exist.
 *
 * Both POSTs are irreversible from the caller's side — pledging collateral
 * makes the position immediately non-withdrawable — so both require an
 * idempotency key (`failClosed`, 24h TTL), use the sensitive rate limiter, and
 * require the BORROW sub-account permission.
 *
 * Scopes: `loans:read` for the GETs, `loans:write` for origination and
 * repayment.
 *
 * Origination returns 201 with the loan queued for disbursal, or 202 with the
 * approval request id when it is waiting on a co-signer. Repayment returns 202
 * either way: the funds are queued, and the loan closes only once the transfer
 * confirms — the response says so explicitly rather than implying the debt is
 * already gone.
 *
 * ─── CO-SIGNING ────────────────────────────────────────────────────────────────
 * Below `LENDING_APPROVAL_THRESHOLD` a loan originates unattended. At or above
 * it, origination is refused outright unless a BORROW approval policy exists to
 * gate it — a check made in the service, not left to the policy's own
 * thresholds, because the approval guard allows an operation outright when no
 * policy matches. A loan that does get gated waits in `PENDING_APPROVAL` until a
 * co-signer replays it; the collateral is already locked in the meantime, which
 * is why the loan row exists before the funds move.
 *
 * ─── SETTLEMENT IS EXACTLY-ONCE ───────────────────────────────────────────────
 * A disbursal or repayment is an outbox op with an idempotency key. If the
 * process dies after the Stellar submission but before the write, the op is
 * redelivered, the settlement is matched against the loan, and
 * `Transaction.loanSettlementAppliedAt` records that it has been consumed. A
 * borrower is never charged twice for one repayment because a job ran twice.
 *
 * The accrual job reconciles before it accrues, so a settlement is always
 * applied before the interest that depends on it is calculated.
 *
 * ─── INTEREST ─────────────────────────────────────────────────────────────────
 * Simple interest on principal, charged at the rate FROZEN at origination. A
 * borrower never sees their bill move because the underlying market's borrow
 * rate moved. Interest is a function of elapsed time rather than a balance a
 * timer maintains, so a missed job tick costs the user nothing and a retried
 * one charges nothing either.
 *
 * All rate fields — on the loan, and in `config.lending` — are in PERCENT, so
 * `8` means 8%. A fraction stored there would under-charge a borrower 100x and
 * the platform would quietly eat the difference.
 *
 * ─── CONFIGURATION ────────────────────────────────────────────────────────────
 * Documented here rather than in `.env.example`, which does not carry the
 * platform's other feature-level config blocks (OUTBOX_*, BREAKER_*).
 * All have working defaults; every one is optional.
 *
 *   LENDING_MAX_LTV                            0.5     origination LTV cap
 *   LENDING_LIQUIDATION_LTV                    0.75    the line a loan is liquidated at
 *   LENDING_LIQUIDATION_TARGET_LTV             0.6     where a sale leaves it
 *   LENDING_MAX_UNDERLYING_THRESHOLD_FRACTION  0.8     ceiling vs the underlying market
 *   LENDING_FALLBACK_BORROW_APY                8       used when no market rate is known
 *   LENDING_PLATFORM_SPREAD_APY                3       platform margin on top
 *   LENDING_MIN_COLLATERAL_VALUE               100     smallest position worth lending on
 *   LENDING_MIN_PRINCIPAL                      10      smallest loan
 *   LENDING_MAX_PRINCIPAL                      50000   largest loan
 *   LENDING_APPROVAL_THRESHOLD                 10000   co-signing bar
 *   LENDING_ACCRUAL_INTERVAL_MS                3600000
 *   LENDING_LIQUIDATION_CHECK_INTERVAL_MS      3600000
 *   LENDING_MAX_COLLATERAL_FRACTION_SOLD       1       per-sale cap
 *
 * The first four are ORDERED, and the ordering is the safety property:
 * `maxLtv < liquidationTargetLtv < liquidationLtvThreshold`, with
 * `maxUnderlyingThresholdFraction < 1`. Invert any pair and the book is
 * quietly unsafe rather than broken — a target above the threshold means every
 * corrective sale immediately re-breaches it, and a cap above the threshold
 * means the platform lends against collateral it has already promised to sell.
 * Nothing throws at runtime, so `assertValidLendingConfig` runs once at module
 * load and refuses to start, listing every violation at once.
 *
 * A separate guard in the service — not a config invariant — is what stops a
 * large loan skipping co-signing: origination at or above
 * `approvalThreshold` is refused when no BORROW policy exists.
 */

import { Router } from 'express'
import {
  borrowingCapacityQuerySchema,
  listLoansQuerySchema,
  loanIdParamSchema,
  originateLoanSchema,
  positionIdParamSchema,
  repayLoanSchema,
} from '../validators/lending-validators'
import {
  getBorrowingCapacity,
  getLoanView,
  listLoansForUser,
  originateLoan,
  repayLoan,
} from '../lending/service'
import { AppError } from '../utils/errors'

const router = Router()

/**
 * Mounted behind `authenticate` in src/index.ts, so `req.auth` is always
 * present. Declared before `/:loanId` so the literal path is not swallowed by
 * the parameterised one.
 */
router.get(
  '/capacity',
  requireScope('loans:read'),
  asyncHandler(async (req, res) => {
    const { positionId } = borrowingCapacityQuerySchema.parse(req.query)
    const result = await getBorrowingCapacity(req.auth!.userId, positionId)
    res.json({ success: true, data: result })
  })
)

router.get(
  '/',
  requireScope('loans:read'),
  asyncHandler(async (req, res) => {
    const { includeClosed } = listLoansQuerySchema.parse(req.query)
    const loans = await listLoansForUser(req.auth!.userId, { includeClosed })
    res.json({ success: true, data: { loans } })
  })
)

router.get(
  '/:loanId',
  requireScope('loans:read'),
  asyncHandler(async (req, res) => {
    const { loanId } = loanIdParamSchema.parse(req.params)
    const loan = await getLoanView(loanId, req.auth!.userId)
    res.json({ success: true, data: loan })
  })
)

router.post(
  '/',
  requireScope('loans:write'),
  asyncHandler(async (req, res) => {
    const body = originateLoanSchema.parse(req.body)
    const result = await originateLoan({
      userId: req.auth!.userId,
      positionId: body.positionId,
      principal: body.amount,
      borrowedAsset: body.assetSymbol,
      memo: body.memo,
    })
    res.status(201).json({ success: true, data: result })
  })
)

router.post(
  '/:loanId/repay',
  requireScope('loans:write'),
  asyncHandler(async (req, res) => {
    const { loanId } = loanIdParamSchema.parse(req.params)
    const { amount } = repayLoanSchema.parse(req.body ?? {})
    const result = await repayLoan({ loanId, userId: req.auth!.userId, amount })
    res.json({ success: true, data: result })
  })
)

export default router
