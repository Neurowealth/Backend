CREATE TYPE "WithdrawalAmountMode" AS ENUM ('FIXED', 'YIELD_ONLY', 'PERCENT_OF_BALANCE');
CREATE TYPE "RecurringWithdrawalPlanStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');
CREATE TABLE "recurring_withdrawal_plans" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "destinationAddress" TEXT NOT NULL,
  "assetSymbol" TEXT NOT NULL, "amountMode" "WithdrawalAmountMode" NOT NULL DEFAULT 'FIXED',
  "amount" DECIMAL(36,18), "percentage" DECIMAL(12,6), "cadence" "DepositCadence" NOT NULL,
  "nextRunAt" TIMESTAMP(3) NOT NULL, "status" "RecurringWithdrawalPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "minAmount" DECIMAL(36,18), "lastRunAt" TIMESTAMP(3), "lastRunStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recurring_withdrawal_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recurring_withdrawal_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "recurring_withdrawal_plans_userId_idx" ON "recurring_withdrawal_plans"("userId");
CREATE INDEX "recurring_withdrawal_plans_status_nextRunAt_idx" ON "recurring_withdrawal_plans"("status", "nextRunAt");
