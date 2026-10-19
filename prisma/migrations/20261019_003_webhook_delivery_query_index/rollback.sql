-- rollback.sql — reverse of 20261019_003_webhook_delivery_query_index/migration.sql
-- Remove the index added after its table was created.
-- Safe to run multiple times.
DROP INDEX IF EXISTS "user_webhook_deliveries_endpointId_createdAt_idx";
