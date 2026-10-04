-- This migration intentionally has no BEGIN/COMMIT: concurrent index builds
-- cannot run inside a transaction. These indexes support user delivery history,
-- subscription health counts, and bounded dead-letter replay queries.
CREATE INDEX CONCURRENTLY "user_webhook_deliveries_endpointId_createdAt_idx"
ON "user_webhook_deliveries"("endpointId", "createdAt");

CREATE INDEX CONCURRENTLY "webhook_deliveries_subscriptionId_status_createdAt_idx"
ON "webhook_deliveries"("subscriptionId", "status", "createdAt");

CREATE INDEX CONCURRENTLY "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx"
ON "webhook_dead_letters"("subscriptionId", "status", "firstFailedAt");