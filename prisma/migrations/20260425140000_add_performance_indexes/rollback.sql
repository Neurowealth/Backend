-- rollback.sql — reverse of 20260425140000_add_performance_indexes/migration.sql
-- Drops new indexes and restores original indexes that were dropped by the migration.

-- Drop indexes added by the migration
DROP INDEX IF EXISTS "agent_logs_userId_status_idx";
DROP INDEX IF EXISTS "agent_logs_status_idx";
DROP INDEX IF EXISTS "transactions_userId_createdAt_idx";
DROP INDEX IF EXISTS "transactions_createdAt_idx";
DROP INDEX IF EXISTS "transactions_status_idx";
DROP INDEX IF EXISTS "transactions_type_idx";
DROP INDEX IF EXISTS "positions_assetSymbol_idx";
DROP INDEX IF EXISTS "positions_protocolName_assetSymbol_idx";
DROP INDEX IF EXISTS "positions_userId_status_idx";
DROP INDEX IF EXISTS "positions_status_idx";
DROP INDEX IF EXISTS "sessions_userId_expiresAt_idx";
DROP INDEX IF EXISTS "sessions_expiresAt_idx";
DROP INDEX IF EXISTS "processed_events_ledger_idx";

-- Restore indexes that the migration dropped
CREATE INDEX "users_walletAddress_idx" ON "users"("walletAddress");
CREATE INDEX "sessions_token_idx" ON "sessions"("token");
CREATE INDEX "transactions_txHash_idx" ON "transactions"("txHash");
