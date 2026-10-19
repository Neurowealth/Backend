-- rollback.sql — reverse of 20260928180000_add_webhook_query_indexes/migration.sql
-- Remove webhook indexes added for hot history, health, and replay queries.
DROP INDEX CONCURRENTLY IF EXISTS "user_webhook_deliveries_endpointId_createdAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "webhook_deliveries_subscriptionId_status_createdAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx";