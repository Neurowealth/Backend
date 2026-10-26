-- AlterTable
ALTER TABLE "recurring_deposit_plans"
  ADD COLUMN "savingsGoalId" TEXT,
  ADD COLUMN "sizingMode" TEXT NOT NULL DEFAULT 'FIXED',
  ADD COLUMN "minAmount" DECIMAL(36, 18),
  ADD COLUMN "maxAmount" DECIMAL(36, 18),
  ADD COLUMN "catchUpHorizon" TEXT NOT NULL DEFAULT 'SPREAD_REMAINING',
  ADD COLUMN "lastShortfall" DECIMAL(36, 18),
  ADD COLUMN "lastClampedBy" TEXT;

-- CreateIndex
CREATE INDEX "recurring_deposit_plans_savingsGoalId_idx" ON "recurring_deposit_plans"("savingsGoalId");

-- AddForeignKey
ALTER TABLE "recurring_deposit_plans"
  ADD CONSTRAINT "recurring_deposit_plans_savingsGoalId_fkey"
  FOREIGN KEY ("savingsGoalId") REFERENCES "savings_goals"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
