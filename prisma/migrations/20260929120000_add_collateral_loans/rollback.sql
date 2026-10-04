-- rollback.sql — reverse of 20260929120000_add_collateral_loans/migration.sql
--
-- Destructive by design: dropping collateral_loans removes the whole lending
-- book. Per docs/MIGRATIONS.md this is the "tier 3" rollback — only valid if
-- no ACTIVE loan exists, because the bad-debt and liquidation history that
-- would be destroyed is the platform's own audit record of value it lost.
--
-- Pre-flight (run before applying):
--   SELECT count(*) FROM collateral_loans WHERE status = 'ACTIVE';
-- A non-zero result means real user debt is outstanding. Cancel the active
-- loans first, or escalate — do not drop the table underneath them.

-- Foreign keys first (children before parents), so this is re-runnable.
ALTER TABLE IF EXISTS "transactions"
DROP CONSTRAINT IF EXISTS "transactions_loanId_fkey";

ALTER TABLE IF EXISTS "platform_bad_debt"
DROP CONSTRAINT IF EXISTS "platform_bad_debt_loanId_fkey";

ALTER TABLE IF EXISTS "loan_liquidation_events"
DROP CONSTRAINT IF EXISTS "loan_liquidation_events_loanId_fkey";

ALTER TABLE IF EXISTS "collateral_loans"
DROP CONSTRAINT IF EXISTS "collateral_loans_positionId_fkey";

ALTER TABLE IF EXISTS "collateral_loans"
DROP CONSTRAINT IF EXISTS "collateral_loans_userId_fkey";

-- The settlement columns come off `transactions` before the loan table does,
-- since the foreign key points at it. Both were NULL for every row written
-- before this migration, so dropping them loses nothing.
DROP INDEX IF EXISTS "transactions_loanId_loanSettlementAppliedAt_idx";
ALTER TABLE IF EXISTS "transactions" DROP COLUMN IF EXISTS "loanSettlementAppliedAt";
ALTER TABLE IF EXISTS "transactions" DROP COLUMN IF EXISTS "loanId";

DROP TABLE IF EXISTS "platform_bad_debt";
DROP TABLE IF EXISTS "loan_liquidation_events";
DROP TABLE IF EXISTS "collateral_loans";

DROP TYPE IF EXISTS "LoanStatus";

-- Enum values are only removable by recreating the type. That means rebuilding
-- the dependent column, which for TransactionType would rewrite every
-- transactions row — not acceptable inside a normal rollback window. The four
-- enum values are therefore deliberately LEFT IN PLACE. Leaving an unused enum
-- value is inert (nothing can select it once the code is reverted); removing
-- it is a scheduled, separately-reviewed migration. See docs/LENDING.md.
