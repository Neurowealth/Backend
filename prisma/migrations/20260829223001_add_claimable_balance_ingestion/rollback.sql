-- Rollback: Remove claimable balance ingestion tables and types
DROP TABLE IF EXISTS "inbound_cursors";
DROP TABLE IF EXISTS "inbound_operations";

-- Note: PostgreSQL doesn't support removing enum values directly
-- This would require recreating the enum type in production
