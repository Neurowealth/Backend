-- Migration: webhook delivery query index
-- Create the index skipped by the earlier migration when this table did not yet exist.
CREATE INDEX IF NOT EXISTS "user_webhook_deliveries_endpointId_createdAt_idx"
ON "user_webhook_deliveries"("endpointId", "createdAt");
