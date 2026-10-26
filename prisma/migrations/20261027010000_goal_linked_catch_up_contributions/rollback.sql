-- DropForeignKey
ALTER TABLE "recurring_deposit_plans" DROP CONSTRAINT IF EXISTS "recurring_deposit_plans_savingsGoalId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "recurring_deposit_plans_savingsGoalId_idx";

-- AlterTable
ALTER TABLE "recurring_deposit_plans"
  DROP COLUMN IF EXISTS "lastClampedBy",
  DROP COLUMN IF EXISTS "lastShortfall",
  DROP COLUMN IF EXISTS "catchUpHorizon",
  DROP COLUMN IF EXISTS "maxAmount",
  DROP COLUMN IF EXISTS "minAmount",
  DROP COLUMN IF EXISTS "sizingMode",
  DROP COLUMN IF EXISTS "savingsGoalId";
