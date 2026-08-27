-- Rollback for 20260817000000_add_fiat_multi_provider

ALTER TABLE "fiat_quote_locks" DROP CONSTRAINT IF EXISTS "fiat_quote_locks_userId_fkey";
DROP TABLE IF EXISTS "fiat_quote_locks";

ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "settledCryptoAmount";
ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "settledRate";
ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "rateLockExpiresAt";
ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "providerQuoteId";
ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "fees";
ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "quotedCryptoAmount";
ALTER TABLE "fiat_orders" DROP COLUMN IF EXISTS "quoteRate";
