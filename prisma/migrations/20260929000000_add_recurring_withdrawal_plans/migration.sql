-- CreateEnum
CREATE TYPE "WithdrawalAmountMode" AS ENUM ('FIXED', 'YIELD_ONLY', 'PERCENT_OF_BALANCE');

-- CreateEnum
CREATE TYPE "RecurringWithdrawalPlanStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "recurring_withdrawal_plans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "amountMode" "WithdrawalAmountMode" NOT NULL DEFAULT 'FIXED',
    "amount" DECIMAL(36,18),
    "amountValue" DECIMAL(36,18),
    "minAmount" DECIMAL(36,18),
    "cadence" "DepositCadence" NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "status" "RecurringWithdrawalPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_withdrawal_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_withdrawal_plans_userId_idx" ON "recurring_withdrawal_plans"("userId");

-- CreateIndex
CREATE INDEX "recurring_withdrawal_plans_status_nextRunAt_idx" ON "recurring_withdrawal_plans"("status", "nextRunAt");

-- AddForeignKey
ALTER TABLE "recurring_withdrawal_plans" ADD CONSTRAINT "recurring_withdrawal_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
