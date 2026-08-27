-- Rollback for 20260725000000_add_recurring_deposit_plans
-- Drops the recurring deposit plans table and its DCA enums.
-- WARNING: Destroys all user-configured recurring deposit plans, their run
-- history (lastRunAt/lastRunStatus), and schedule state. None of this is
-- reconstructible from other tables — plans are user input, not derived data.
-- Re-applying the migration restores the schema but not the rows.

ALTER TABLE "recurring_deposit_plans" DROP CONSTRAINT IF EXISTS "recurring_deposit_plans_userId_fkey";

DROP TABLE IF EXISTS "recurring_deposit_plans";

DROP TYPE IF EXISTS "RecurringDepositPlanStatus";

DROP TYPE IF EXISTS "DepositCadence";
