-- rollback.sql — reverse of 20260828160000_smart_dca_engine/migration.sql
-- Remove Smart DCA run history and plan fields.
-- WARNING: DATA LOSS — recurring deposit run history and Smart DCA settings are
-- permanently removed. Restore from a snapshot if this data is needed.
-- Safe to run multiple times.

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
