-- rollback.sql — reverse of 20260827150000_webhook_hardening/migration.sql
-- Removes the webhook hardening tables and columns.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260827150000_webhook_hardening/rollback.sql

ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "webhook_dead_letters_subscriptionId_fkey";
DROP TABLE IF EXISTS "webhook_dead_letters";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "autoReplay";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "secretNextActiveAt";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "secretNext";
