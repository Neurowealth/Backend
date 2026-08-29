-- Rollback for 20260824215727_add_multi_method_tax_engine
-- Drops the multi-method tax engine's schema additions (#317).
--
-- WARNING: Dropping "accountingMethod" loses each user's configured
-- consumption method (they revert to FIFO on re-add). Dropping
-- "selectedLotIds" loses any in-flight SPECIFIC_ID withdrawal's lot
-- selection that hasn't been consumed by the event listener yet — deploy
-- the reverted application code BEFORE running this, since the live event
-- listener reads Transaction.selectedLotIds on every withdrawal
-- confirmation (src/tax/service.ts's recordDisposalsForWithdrawal).
--
-- IRREVERSIBLE STEP: PostgreSQL cannot drop a single enum value
-- (`ALTER TYPE ... DROP VALUE` does not exist). USER_DECLARED and
-- MARKET_FEED are left on the "PriceSource" enum — harmless (no row can
-- reference them once nothing writes them), but they will linger in the
-- type's value list. Rebuild the enum manually if that matters:
--   CREATE TYPE "PriceSource_new" AS ENUM ('STABLECOIN_ASSUMPTION');
--   ALTER TABLE "cost_basis_lots" ALTER COLUMN "priceSource" TYPE "PriceSource_new" USING ("priceSource"::text::"PriceSource_new");
--   ALTER TABLE "lot_disposals" ALTER COLUMN ... -- if priced elsewhere
--   DROP TYPE "PriceSource";
--   ALTER TYPE "PriceSource_new" RENAME TO "PriceSource";

ALTER TABLE "transactions" DROP COLUMN IF EXISTS "selectedLotIds";

ALTER TABLE "users" DROP COLUMN IF EXISTS "methodEffectiveAt";
ALTER TABLE "users" DROP COLUMN IF EXISTS "accountingMethod";

DROP TYPE IF EXISTS "AccountingMethod";
