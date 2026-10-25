-- rollback.sql — reverse of 20260902000000_harden_session_refresh_tokens/migration.sql
-- Removes the refresh-token hardening columns and their lookup index.
-- WARNING: DATA LOSS — refreshTokenRotations is a diagnostic counter and
-- refreshTokenUsedAt is replay-detection state. Reverting reinstates the
-- pre-#472 behaviour, where a stolen refresh token is indistinguishable from an
-- expired one, so only roll back with the older application version (#472).
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260902000000_harden_session_refresh_tokens/rollback.sql

DROP INDEX IF EXISTS "sessions_refreshTokenPrefix_idx";

ALTER TABLE "sessions" DROP COLUMN IF EXISTS "refreshTokenRotations";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "refreshTokenUsedAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "refreshTokenPrefix";
