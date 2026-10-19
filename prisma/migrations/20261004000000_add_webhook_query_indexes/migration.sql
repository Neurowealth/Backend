-- This migration creates indexes to support user delivery history,
-- subscription health counts, and bounded dead-letter replay queries.
-- CONCURRENTLY removed for CI/test environments to allow transaction-wrapped execution.
CREATE INDEX IF NOT EXISTS "user_webhook_deliveries_endpointId_createdAt_idx"
ON "user_webhook_deliveries"("endpointId", "createdAt");

CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscriptionId_status_createdAt_idx"
ON "webhook_deliveries"("subscriptionId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx"
ON "webhook_dead_letters"("subscriptionId", "status", "firstFailedAt");
