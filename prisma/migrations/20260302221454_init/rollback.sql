-- Rollback for 20260302221454_init
-- Reverses the initial schema: drops foreign keys, tables, and enums.
-- WARNING: This drops every core table and DESTROYS ALL DATA. Take a backup first.

-- DropForeignKey
ALTER TABLE "agent_logs" DROP CONSTRAINT IF EXISTS "agent_logs_userId_fkey";
ALTER TABLE "yield_snapshots" DROP CONSTRAINT IF EXISTS "yield_snapshots_positionId_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_positionId_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_userId_fkey";
ALTER TABLE "positions" DROP CONSTRAINT IF EXISTS "positions_userId_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_userId_fkey";

-- DropTable (indexes are dropped with their table)
DROP TABLE IF EXISTS "agent_logs";
DROP TABLE IF EXISTS "protocol_rates";
DROP TABLE IF EXISTS "yield_snapshots";
DROP TABLE IF EXISTS "transactions";
DROP TABLE IF EXISTS "positions";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "users";

-- DropEnum
DROP TYPE IF EXISTS "AgentStatus";
DROP TYPE IF EXISTS "AgentAction";
DROP TYPE IF EXISTS "PositionStatus";
DROP TYPE IF EXISTS "TransactionStatus";
DROP TYPE IF EXISTS "TransactionType";
DROP TYPE IF EXISTS "Network";
