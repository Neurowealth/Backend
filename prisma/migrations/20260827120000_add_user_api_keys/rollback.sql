-- rollback.sql — reverse of 20260827120000_add_user_api_keys/migration.sql
-- Drops the user_api_keys table and its FK constraint.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260827120000_add_user_api_keys/rollback.sql

ALTER TABLE "user_api_keys" DROP CONSTRAINT IF EXISTS "user_api_keys_userId_fkey";
DROP TABLE IF EXISTS "user_api_keys";
