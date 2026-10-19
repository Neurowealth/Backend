-- rollback.sql — reverse of 20261008090000_recurring_withdrawals/migration.sql
-- Remove recurring withdrawal plans and their migration-specific enum types.
-- WARNING: DATA LOSS — recurring withdrawal plans are permanently removed.
-- Restore from a snapshot if this data is needed.
-- Safe to run multiple times.

DROP TABLE IF EXISTS "recurring_withdrawal_plans";

DROP TYPE IF EXISTS "RecurringWithdrawalPlanStatus";
DROP TYPE IF EXISTS "WithdrawalAmountMode";
