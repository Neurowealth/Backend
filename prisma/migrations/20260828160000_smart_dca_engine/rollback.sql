-- Rollback: 20260828160000_smart_dca_engine
-- Drops Smart DCA run history and fields added to recurring_deposit_plans.
DROP TABLE IF EXISTS "recurring_deposit_runs";
ALTER TABLE "recurring_deposit_plans"
  DROP COLUMN IF EXISTS "policy",
  DROP COLUMN IF EXISTS "catchUpMode",
  DROP COLUMN IF EXISTS "pauseOnDrawdownPct",
  DROP COLUMN IF EXISTS "doubleOnDrawdown",
  DROP COLUMN IF EXISTS "accumulatedRuns",
  DROP COLUMN IF EXISTS "consecutiveFailures",
  DROP COLUMN IF EXISTS "autoPauseReason",
  DROP COLUMN IF EXISTS "allocationMap";
DROP TYPE IF EXISTS "RecurringDepositRunStatus";
DROP TYPE IF EXISTS "CatchUpMode";
DROP TYPE IF EXISTS "ContributionPolicy";
