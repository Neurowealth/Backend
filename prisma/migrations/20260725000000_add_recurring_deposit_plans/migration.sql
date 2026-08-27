-- CreateEnum
CREATE TYPE "DepositCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "RecurringDepositPlanStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "recurring_deposit_plans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "cadence" "DepositCadence" NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "status" "RecurringDepositPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_deposit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_deposit_plans_userId_idx" ON "recurring_deposit_plans"("userId");

-- CreateIndex
CREATE INDEX "recurring_deposit_plans_status_nextRunAt_idx" ON "recurring_deposit_plans"("status", "nextRunAt");

-- AddForeignKey
ALTER TABLE "recurring_deposit_plans" ADD CONSTRAINT "recurring_deposit_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
