ALTER TABLE "users" ADD COLUMN "goalFundingMode" TEXT NOT NULL DEFAULT 'SEQUENTIAL';

ALTER TABLE "savings_goals"
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "allocationWeight" DECIMAL(36, 18) NOT NULL DEFAULT 1,
  ADD COLUMN "fundingMode" TEXT NOT NULL DEFAULT 'SEQUENTIAL';

CREATE TABLE "goal_allocations" (
  "id" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "amount" DECIMAL(36, 18) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goal_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "goal_allocations_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "savings_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "goal_allocations_goalId_idx" ON "goal_allocations"("goalId");
CREATE INDEX "goal_allocations_sourceId_idx" ON "goal_allocations"("sourceId");
