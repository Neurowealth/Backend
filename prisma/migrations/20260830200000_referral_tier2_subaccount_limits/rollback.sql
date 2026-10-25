-- rollback.sql — reverse of 20260830200000_referral_tier2_subaccount_limits/migration.sql
-- Removes the referral tier-2 and sub-account limit columns.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260830200000_referral_tier2_subaccount_limits/rollback.sql

ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "tier2RewardTxId";
ALTER TABLE "sub_accounts" DROP COLUMN IF EXISTS "transactionLimit";
ALTER TABLE "sub_accounts" DROP COLUMN IF EXISTS "dailyLimit";
