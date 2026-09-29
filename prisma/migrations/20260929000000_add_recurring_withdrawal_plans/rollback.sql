-- Rollback for 20260929000000_add_recurring_withdrawal_plans
-- Drops recurring_withdrawal_plans table and associated enums.

ALTER TABLE "recurring_withdrawal_plans" DROP CONSTRAINT IF EXISTS "recurring_withdrawal_plans_userId_fkey";

DROP TABLE IF EXISTS "recurring_withdrawal_plans";

DROP TYPE IF EXISTS "RecurringWithdrawalPlanStatus";

DROP TYPE IF EXISTS "WithdrawalAmountMode";
