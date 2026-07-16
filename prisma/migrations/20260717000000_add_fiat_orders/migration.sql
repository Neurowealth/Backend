-- CreateEnum
CREATE TYPE "FiatDirection" AS ENUM ('ON_RAMP', 'OFF_RAMP');

-- CreateEnum
CREATE TYPE "FiatOrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'SETTLED', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "fiat_orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT NOT NULL,
    "direction" "FiatDirection" NOT NULL,
    "fiatAmount" DECIMAL(36,18) NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "cryptoAmount" DECIMAL(36,18),
    "assetSymbol" TEXT NOT NULL,
    "status" "FiatOrderStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "checkoutUrl" TEXT,
    "kycUrl" TEXT,
    "failureReason" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiat_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiat_orders_userId_idx" ON "fiat_orders"("userId");

-- CreateIndex
CREATE INDEX "fiat_orders_provider_providerOrderId_idx" ON "fiat_orders"("provider", "providerOrderId");

-- CreateIndex
CREATE INDEX "fiat_orders_status_idx" ON "fiat_orders"("status");

-- CreateIndex
CREATE INDEX "fiat_orders_createdAt_idx" ON "fiat_orders"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "fiat_orders_provider_providerOrderId_key" ON "fiat_orders"("provider", "providerOrderId");

-- AddForeignKey
ALTER TABLE "fiat_orders" ADD CONSTRAINT "fiat_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiat_orders" ADD CONSTRAINT "fiat_orders_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
