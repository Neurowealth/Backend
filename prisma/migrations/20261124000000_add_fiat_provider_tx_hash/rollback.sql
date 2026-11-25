-- Rollback for 20261124000000_add_fiat_provider_tx_hash
ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "providerTxHash";
