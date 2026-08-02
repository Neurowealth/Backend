-- Rollback for 20260627000000_add_webhook_tables
-- Drops the webhook tables and the WebhookDeliveryStatus enum.
-- WARNING: Destroys all webhook subscriptions and delivery history.

ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_subscriptionId_fkey";

ALTER TABLE "webhook_subscriptions" DROP CONSTRAINT IF EXISTS "webhook_subscriptions_userId_fkey";

DROP TABLE IF EXISTS "webhook_deliveries";

DROP TABLE IF EXISTS "webhook_subscriptions";

DROP TYPE IF EXISTS "WebhookDeliveryStatus";
