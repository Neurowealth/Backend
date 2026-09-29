-- Rollback for 20260929120000_add_user_liquidity_floor
ALTER TABLE "users" DROP COLUMN IF EXISTS "liquidityFloor";
