-- rollback.sql — reverse of 20260904000000_add_digest_subscriptions/migration.sql
-- Drops the cross-channel digest subscription ledger (#365).
-- WARNING: DATA LOSS — all digest scheduling prefs are lost.
-- Indexes are dropped with the table (explicit drops for idempotency).
-- Safe to run multiple times. Revert app code BEFORE running.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260904000000_add_digest_subscriptions/rollback.sql

DROP TABLE IF EXISTS "digest_subscriptions" CASCADE;
DROP TYPE IF EXISTS "DigestChannel";
DROP TYPE IF EXISTS "DigestFrequency";
