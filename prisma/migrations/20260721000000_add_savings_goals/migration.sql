-- Goal-based investing (#281). Adds a SavingsGoal table so a user can state a
-- target amount + date and have the agent's strategy selection driven by the
-- gap between where they are and where they need to be.

-- AlterEnum
ALTER TYPE "AgentAction" ADD VALUE 'GOAL_PROGRESS';

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'MISSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "savings_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT,
    "targetAmount" DECIMAL(36,18) NOT NULL,
    "startingAmount" DECIMAL(36,18) NOT NULL,
    "targetDate" TIMESTAMP(3) NOT NULL,
    "riskCeiling" INTEGER,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_goals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "savings_goals_userId_idx" ON "savings_goals"("userId");

-- CreateIndex
CREATE INDEX "savings_goals_status_idx" ON "savings_goals"("status");

-- CreateIndex
CREATE INDEX "savings_goals_userId_status_idx" ON "savings_goals"("userId", "status");

-- AddForeignKey
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
