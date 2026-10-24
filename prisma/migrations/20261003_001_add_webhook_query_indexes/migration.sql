-- This migration creates indexes to support user delivery history,
-- subscription health counts, and bounded dead-letter replay queries.
-- CONCURRENTLY removed for CI/test environments to allow transaction-wrapped execution.
-- user_webhook_deliveries is created by the later-sorting
-- 20261003_add_missing_models migration. Existing databases may already have
-- the table, so create the index here only when it is available; a follow-up
-- migration creates it after the table on fresh databases.
DO $$
BEGIN
  IF to_regclass('"user_webhook_deliveries"') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "user_webhook_deliveries_endpointId_createdAt_idx"
    ON "user_webhook_deliveries"("endpointId", "createdAt");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscriptionId_status_createdAt_idx"
ON "webhook_deliveries"("subscriptionId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx"
ON "webhook_dead_letters"("subscriptionId", "status", "firstFailedAt");
