-- Rollback for 20260717000000_add_fiat_orders
-- Drops the fiat_orders table and its enums (#290).
-- WARNING: Destroys all fiat on-ramp/off-ramp order metadata and status history.

ALTER TABLE "fiat_orders" DROP CONSTRAINT IF EXISTS "fiat_orders_transactionId_fkey";

ALTER TABLE "fiat_orders" DROP CONSTRAINT IF EXISTS "fiat_orders_userId_fkey";

DROP TABLE IF EXISTS "fiat_orders";

DROP TYPE IF EXISTS "FiatOrderStatus";

DROP TYPE IF EXISTS "FiatDirection";
