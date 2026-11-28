-- #827 Preserve the provider's claimed settlement transaction across retries.
ALTER TABLE "fiat_orders" ADD COLUMN "providerTxHash" TEXT;
