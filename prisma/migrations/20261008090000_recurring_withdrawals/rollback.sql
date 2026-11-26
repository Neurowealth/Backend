-- Rollback: 20261008090000_recurring_withdrawals
DROP TABLE IF EXISTS "recurring_withdrawal_plans";
DROP TYPE IF EXISTS "RecurringWithdrawalPlanStatus";
DROP TYPE IF EXISTS "WithdrawalAmountMode";
