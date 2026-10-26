-- Rollback: 20261027000000_multi_goals_allocation
DROP TABLE IF EXISTS "goal_allocations";
ALTER TABLE "savings_goals"
  DROP COLUMN IF EXISTS "fundingMode",
  DROP COLUMN IF EXISTS "allocationWeight",
  DROP COLUMN IF EXISTS "priority";
ALTER TABLE "users" DROP COLUMN IF EXISTS "goalFundingMode";
