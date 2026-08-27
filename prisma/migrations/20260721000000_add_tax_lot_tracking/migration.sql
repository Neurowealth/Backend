-- Tax reporting & cost-basis lot tracking (#284). One lot per confirmed
-- deposit Transaction; FIFO disposals recorded per withdrawal. Nullable price
-- columns mean "unpriced" (excluded from report totals), never zero.

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('STABLECOIN_ASSUMPTION');

-- CreateTable
CREATE TABLE "cost_basis_lots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "originalAmount" DECIMAL(36,18) NOT NULL,
    "remainingAmount" DECIMAL(36,18) NOT NULL,
    "acquisitionPrice" DECIMAL(36,18),
    "priceSource" "PriceSource",
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_basis_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_disposals" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "disposalPrice" DECIMAL(36,18),
    "costBasis" DECIMAL(36,18),
    "proceeds" DECIMAL(36,18),
    "realizedGain" DECIMAL(36,18),
    "disposedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_disposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cost_basis_lots_transactionId_key" ON "cost_basis_lots"("transactionId");

-- CreateIndex
CREATE INDEX "cost_basis_lots_userId_assetSymbol_acquiredAt_idx" ON "cost_basis_lots"("userId", "assetSymbol", "acquiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "lot_disposals_transactionId_lotId_key" ON "lot_disposals"("transactionId", "lotId");

-- CreateIndex
CREATE INDEX "lot_disposals_userId_disposedAt_idx" ON "lot_disposals"("userId", "disposedAt");

-- AddForeignKey
ALTER TABLE "cost_basis_lots" ADD CONSTRAINT "cost_basis_lots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_basis_lots" ADD CONSTRAINT "cost_basis_lots_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_disposals" ADD CONSTRAINT "lot_disposals_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "cost_basis_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_disposals" ADD CONSTRAINT "lot_disposals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_disposals" ADD CONSTRAINT "lot_disposals_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
