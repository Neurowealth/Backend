-- Rollback for 20260721000000_add_tax_lot_tracking
-- Drops the cost-basis lot / disposal tables and the PriceSource enum.
-- WARNING: Destroys all cost-basis and realized-gain tracking history. Lots
-- and disposals are deterministically reconstructible from CONFIRMED
-- Transactions via scripts/backfill-cost-basis-lots.ts after re-applying.

ALTER TABLE "lot_disposals" DROP CONSTRAINT IF EXISTS "lot_disposals_transactionId_fkey";

ALTER TABLE "lot_disposals" DROP CONSTRAINT IF EXISTS "lot_disposals_userId_fkey";

ALTER TABLE "lot_disposals" DROP CONSTRAINT IF EXISTS "lot_disposals_lotId_fkey";

ALTER TABLE "cost_basis_lots" DROP CONSTRAINT IF EXISTS "cost_basis_lots_transactionId_fkey";

ALTER TABLE "cost_basis_lots" DROP CONSTRAINT IF EXISTS "cost_basis_lots_userId_fkey";

DROP TABLE IF EXISTS "lot_disposals";

DROP TABLE IF EXISTS "cost_basis_lots";

DROP TYPE IF EXISTS "PriceSource";
