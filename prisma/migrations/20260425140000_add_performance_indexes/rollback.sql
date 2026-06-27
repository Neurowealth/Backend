-- Rollback for 20260425140000_add_performance_indexes
-- Drops the indexes the forward migration created and recreates the three it dropped.
-- Index-only changes: no data is affected.

-- Recreate indexes that the forward migration dropped
CREATE INDEX IF NOT EXISTS "users_walletAddress_idx" ON "users"("walletAddress");
CREATE INDEX IF NOT EXISTS "sessions_token_idx" ON "sessions"("token");
CREATE INDEX IF NOT EXISTS "transactions_txHash_idx" ON "transactions"("txHash");

-- Drop indexes the forward migration created
DROP INDEX IF EXISTS "sessions_expiresAt_idx";
DROP INDEX IF EXISTS "sessions_userId_expiresAt_idx";
DROP INDEX IF EXISTS "positions_status_idx";
DROP INDEX IF EXISTS "positions_userId_status_idx";
DROP INDEX IF EXISTS "positions_protocolName_assetSymbol_idx";
DROP INDEX IF EXISTS "positions_assetSymbol_idx";
DROP INDEX IF EXISTS "transactions_type_idx";
DROP INDEX IF EXISTS "transactions_status_idx";
DROP INDEX IF EXISTS "transactions_createdAt_idx";
DROP INDEX IF EXISTS "transactions_userId_createdAt_idx";
DROP INDEX IF EXISTS "agent_logs_status_idx";
DROP INDEX IF EXISTS "agent_logs_userId_status_idx";
DROP INDEX IF EXISTS "processed_events_ledger_idx";
