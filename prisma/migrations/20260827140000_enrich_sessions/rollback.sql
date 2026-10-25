-- rollback.sql — reverse of 20260827140000_enrich_sessions/migration.sql
-- Removes the session enrichment columns added by the migration.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260827140000_enrich_sessions/rollback.sql

DROP INDEX IF EXISTS "sessions_revokedAt_idx";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "approxLocation";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "revokedReason";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "revokedAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "lastSeenIp";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "lastSeenAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "deviceType";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "label";
