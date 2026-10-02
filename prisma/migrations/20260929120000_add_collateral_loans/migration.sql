-- #532 Borrow Against Deposited Collateral (non-liquidating credit line).
--
-- Three new tables (collateral_loans, loan_liquidation_events,
-- platform_bad_debt) plus three new outbox/transaction kinds and a new
-- sub-account permission. All additive: no existing column changes type or
-- meaning, so this is a zero-downtime, backwards-compatible expansion.
--
-- The two columns added to `transactions` are NULL for every existing row, so
-- the addition is a no-op for the current write path.

-- ── Enum additions ───────────────────────────────────────────────────────────
-- ALTER TYPE ... ADD VALUE is not transactional in PostgreSQL < 12, but the
-- minimum supported server here is 12+, where it is. Each value is committed
-- in its own statement so a failure cannot leave a half-added kind behind.
ALTER TYPE "OutboxOpKind" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSE';
ALTER TYPE "OutboxOpKind" ADD VALUE IF NOT EXISTS 'LOAN_REPAYMENT';
ALTER TYPE "OutboxOpKind" ADD VALUE IF NOT EXISTS 'LOAN_LIQUIDATION';

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'LOAN_REPAYMENT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'LOAN_LIQUIDATION';

ALTER TYPE "SubAccountPermission" ADD VALUE IF NOT EXISTS 'BORROW';

CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'REPAID', 'LIQUIDATED');

-- ── transactions: loan settlement columns ─────────────────────────────────────
-- "loanId" links a settlement to the loan it belongs to; "loanSettlementAppliedAt"
-- is the exactly-once marker the loan reconciler claims rows with. Both are
-- NULL for every pre-existing row, so nothing about the current deposit /
-- withdraw / rebalance write path changes.
ALTER TABLE "transactions" ADD COLUMN "loanId" TEXT;
ALTER TABLE "transactions" ADD COLUMN "loanSettlementAppliedAt" TIMESTAMP(3);

CREATE INDEX "transactions_loanId_loanSettlementAppliedAt_idx"
ON "transactions"("loanId", "loanSettlementAppliedAt");

ALTER TABLE "transactions"
ADD CONSTRAINT "transactions_loanId_fkey"
FOREIGN KEY ("loanId") REFERENCES "collateral_loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── collateral_loans ─────────────────────────────────────────────────────────
CREATE TABLE "collateral_loans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "borrowedAsset" TEXT NOT NULL,
    "principalAmount" DECIMAL(36,18) NOT NULL,
    "interestAccrued" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "interestAccruedTo" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "underlyingBorrowApy" DECIMAL(12,6) NOT NULL,
    "platformSpreadApy" DECIMAL(12,6) NOT NULL,
    "interestRateApy" DECIMAL(12,6) NOT NULL,
    "ltvRatio" DECIMAL(12,6) NOT NULL,
    "liquidationLtvThreshold" DECIMAL(12,6) NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "originatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "lastValuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastValuedCollateral" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "disburseOutboxOpId" TEXT,
    "liquidationOutboxOpId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collateral_loans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "collateral_loans_userId_status_idx"
ON "collateral_loans"("userId", "status");

CREATE INDEX "collateral_loans_status_idx"
ON "collateral_loans"("status");

CREATE INDEX "collateral_loans_positionId_status_idx"
ON "collateral_loans"("positionId", "status");

CREATE INDEX "collateral_loans_status_lastValuedAt_idx"
ON "collateral_loans"("status", "lastValuedAt");

-- v1 rule: at most ONE active loan per locked position. Enforced here rather
-- than in the service so two concurrent origination requests can never both
-- win the "is this position already pledged?" check.
CREATE UNIQUE INDEX "collateral_loans_one_active_per_position_key"
ON "collateral_loans"("positionId")
WHERE "status" = 'ACTIVE';

ALTER TABLE "collateral_loans"
ADD CONSTRAINT "collateral_loans_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "collateral_loans"
ADD CONSTRAINT "collateral_loans_positionId_fkey"
FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── loan_liquidation_events ──────────────────────────────────────────────────
CREATE TABLE "loan_liquidation_events" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ltvBefore" DECIMAL(12,6) NOT NULL,
    "ltvAfter" DECIMAL(12,6),
    "collateralSold" DECIMAL(36,18) NOT NULL,
    "debtRetired" DECIMAL(36,18) NOT NULL,
    "shortfall" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "outboxOpId" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_liquidation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "loan_liquidation_events_loanId_createdAt_idx"
ON "loan_liquidation_events"("loanId", "createdAt");

CREATE INDEX "loan_liquidation_events_userId_createdAt_idx"
ON "loan_liquidation_events"("userId", "createdAt");

CREATE INDEX "loan_liquidation_events_createdAt_idx"
ON "loan_liquidation_events"("createdAt");

ALTER TABLE "loan_liquidation_events"
ADD CONSTRAINT "loan_liquidation_events_loanId_fkey"
FOREIGN KEY ("loanId") REFERENCES "collateral_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── platform_bad_debt ────────────────────────────────────────────────────────
CREATE TABLE "platform_bad_debt" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "platform_bad_debt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_bad_debt_status_recordedAt_idx"
ON "platform_bad_debt"("status", "recordedAt");

CREATE INDEX "platform_bad_debt_loanId_idx"
ON "platform_bad_debt"("loanId");

ALTER TABLE "platform_bad_debt"
ADD CONSTRAINT "platform_bad_debt_loanId_fkey"
FOREIGN KEY ("loanId") REFERENCES "collateral_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
