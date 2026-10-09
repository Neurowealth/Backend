-- CreateEnum
CREATE TYPE "ContributionPolicy" AS ENUM ('FIXED', 'ADAPTIVE');

-- CreateEnum
CREATE TYPE "CatchUpMode" AS ENUM ('SKIP', 'ACCUMULATE', 'RETRY');

-- CreateEnum
CREATE TYPE "RecurringDepositRunStatus" AS ENUM ('EXECUTED', 'SKIPPED', 'FAILED', 'PENDING_APPROVAL', 'PARTIAL');

-- AlterTable: Extend RecurringDepositPlan with Smart DCA fields
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "policy" "ContributionPolicy" NOT NULL DEFAULT 'FIXED';
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "catchUpMode" "CatchUpMode" NOT NULL DEFAULT 'RETRY';
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "pauseOnDrawdownPct" DOUBLE PRECISION;
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "doubleOnDrawdown" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "accumulatedRuns" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "autoPauseReason" TEXT;
ALTER TABLE "recurring_deposit_plans" ADD COLUMN "allocationMap" JSONB;

-- CreateTable: RecurringDepositRun (per-run ledger)
CREATE TABLE "recurring_deposit_runs" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baselineAmount" DECIMAL(36,18) NOT NULL,
    "appliedAmount" DECIMAL(36,18) NOT NULL,
    "regimeSnapshot" JSONB,
    "reasoning" TEXT,
    "status" "RecurringDepositRunStatus" NOT NULL DEFAULT 'EXECUTED',
    "txHash" TEXT,
    "errorMessage" TEXT,
    "allocationLegs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_deposit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_deposit_runs_planId_idx" ON "recurring_deposit_runs"("planId");
CREATE INDEX "recurring_deposit_runs_userId_idx" ON "recurring_deposit_runs"("userId");
CREATE INDEX "recurring_deposit_runs_createdAt_idx" ON "recurring_deposit_runs"("createdAt");

-- AddForeignKey
ALTER TABLE "recurring_deposit_runs" ADD CONSTRAINT "recurring_deposit_runs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "recurring_deposit_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_deposit_runs" ADD CONSTRAINT "recurring_deposit_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
