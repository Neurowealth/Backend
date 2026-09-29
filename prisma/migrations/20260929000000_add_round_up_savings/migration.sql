-- CreateEnum
CREATE TYPE "RoundUpAccrualStatus" AS ENUM ('ACCRUED', 'EXECUTING', 'SWEPT');

-- CreateTable
CREATE TABLE "round_up_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "roundToNearest" DECIMAL(10,2) NOT NULL DEFAULT 1.0,
    "multiplier" DECIMAL(10,2) NOT NULL DEFAULT 1.0,
    "targetGoalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_up_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_up_accruals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fiatOrderId" TEXT,
    "purchaseAmount" DECIMAL(36,18) NOT NULL,
    "roundUpAmount" DECIMAL(36,18) NOT NULL,
    "multiplier" DECIMAL(10,2) NOT NULL DEFAULT 1.0,
    "totalRoundUp" DECIMAL(36,18) NOT NULL,
    "status" "RoundUpAccrualStatus" NOT NULL DEFAULT 'ACCRUED',
    "sweptAt" TIMESTAMP(3),
    "sweepTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_up_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "round_up_settings_userId_key" ON "round_up_settings"("userId");

-- CreateIndex
CREATE INDEX "round_up_settings_userId_idx" ON "round_up_settings"("userId");

-- CreateIndex
CREATE INDEX "round_up_accruals_userId_status_idx" ON "round_up_accruals"("userId", "status");

-- CreateIndex
CREATE INDEX "round_up_accruals_status_createdAt_idx" ON "round_up_accruals"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "round_up_settings" ADD CONSTRAINT "round_up_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_up_settings" ADD CONSTRAINT "round_up_settings_targetGoalId_fkey" FOREIGN KEY ("targetGoalId") REFERENCES "savings_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_up_accruals" ADD CONSTRAINT "round_up_accruals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_up_accruals" ADD CONSTRAINT "round_up_accruals_fiatOrderId_fkey" FOREIGN KEY ("fiatOrderId") REFERENCES "fiat_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_up_accruals" ADD CONSTRAINT "round_up_accruals_sweepTransactionId_fkey" FOREIGN KEY ("sweepTransactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
