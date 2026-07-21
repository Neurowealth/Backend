-- Rollback for 20260721120000_add_user_rebalance_strategy
-- Drops the per-user rebalance strategy columns.
-- WARNING: Destroys any user-selected strategy preferences.

ALTER TABLE "users" DROP COLUMN IF EXISTS "strategyConfig";

ALTER TABLE "users" DROP COLUMN IF EXISTS "rebalanceStrategy";
