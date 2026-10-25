-- rollback.sql — reverse of 20260928120000_add_marketplace_tags/migration.sql
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260928120000_add_marketplace_tags/rollback.sql

ALTER TABLE "published_strategies" DROP COLUMN IF EXISTS "description";
ALTER TABLE "published_strategies" DROP COLUMN IF EXISTS "tags";
DROP TABLE IF EXISTS "marketplace_tags";
