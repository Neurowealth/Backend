-- rollback.sql — reverse of 20260829000000_protocol_yield_composition/migration.sql
-- Removes the yield-composition columns from protocol_rates.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260829000000_protocol_yield_composition/rollback.sql

ALTER TABLE "protocol_rates" DROP COLUMN IF EXISTS "rewardTokens";
ALTER TABLE "protocol_rates" DROP COLUMN IF EXISTS "incentiveApy";
ALTER TABLE "protocol_rates" DROP COLUMN IF EXISTS "baseApy";
