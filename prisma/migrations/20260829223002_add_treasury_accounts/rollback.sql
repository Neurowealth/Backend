-- rollback.sql — reverse of 20260829223002_add_treasury_accounts/migration.sql
-- Removes the treasury account tables and types.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260829223002_add_treasury_accounts/rollback.sql

DROP TABLE IF EXISTS "multisig_envelopes";
DROP TABLE IF EXISTS "treasury_sweeps";
DROP TABLE IF EXISTS "treasury_accounts";
DROP TYPE IF EXISTS "TreasuryTier";

-- Note: PostgreSQL doesn't support removing enum values directly
-- This would require recreating the enum type in production
