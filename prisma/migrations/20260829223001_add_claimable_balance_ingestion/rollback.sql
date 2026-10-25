-- rollback.sql — reverse of 20260829223001_add_claimable_balance_ingestion/migration.sql
-- Removes the claimable balance ingestion tables and types.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260829223001_add_claimable_balance_ingestion/rollback.sql

DROP TABLE IF EXISTS "inbound_cursors";
DROP TABLE IF EXISTS "inbound_operations";

-- Note: PostgreSQL doesn't support removing enum values directly
-- This would require recreating the enum type in production
