-- AlterTable: rate-drift protection fields on fiat_orders (#313)
ALTER TABLE "fiat_orders" ADD COLUMN "quoteRate" DECIMAL(36,18);
ALTER TABLE "fiat_orders" ADD COLUMN "quotedCryptoAmount" DECIMAL(36,18);
ALTER TABLE "fiat_orders" ADD COLUMN "fees" JSONB;
ALTER TABLE "fiat_orders" ADD COLUMN "providerQuoteId" TEXT;
ALTER TABLE "fiat_orders" ADD COLUMN "rateLockExpiresAt" TIMESTAMP(3);
ALTER TABLE "fiat_orders" ADD COLUMN "settledRate" DECIMAL(36,18);
ALTER TABLE "fiat_orders" ADD COLUMN "settledCryptoAmount" DECIMAL(36,18);

-- CreateTable: time-boxed provider-pinned quotes (#313)
CREATE TABLE "fiat_quote_locks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "direction" "FiatDirection" NOT NULL,
    "fiatAmount" DECIMAL(36,18) NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "cryptoAmount" DECIMAL(36,18) NOT NULL,
    "rate" DECIMAL(36,18),
    "fees" JSONB,
    "providerQuoteId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiat_quote_locks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fiat_quote_locks_userId_idx" ON "fiat_quote_locks"("userId");
CREATE INDEX "fiat_quote_locks_expiresAt_idx" ON "fiat_quote_locks"("expiresAt");
CREATE INDEX "fiat_quote_locks_provider_idx" ON "fiat_quote_locks"("provider");

ALTER TABLE "fiat_quote_locks" ADD CONSTRAINT "fiat_quote_locks_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
