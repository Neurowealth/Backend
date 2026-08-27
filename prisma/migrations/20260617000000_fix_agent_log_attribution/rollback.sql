-- rollback.sql — reverse of 20260617000000_fix_agent_log_attribution/migration.sql
--
-- Restores agent_logs.userId to NOT NULL and drops positionId.
-- NOTE: If any existing rows have userId=NULL (system-level logs written after
-- the migration), they must be reassigned or deleted before re-adding the
-- NOT NULL constraint. Document any such rows before running this rollback.
--
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260617000000_fix_agent_log_attribution/rollback.sql

-- Remove indexes added by the migration
DROP INDEX IF EXISTS "agent_logs_userId_createdAt_idx";
DROP INDEX IF EXISTS "agent_logs_positionId_idx";

-- Remove the positionId column
ALTER TABLE "agent_logs" DROP COLUMN IF EXISTS "positionId";

-- Restore userId NOT NULL (fails if any null rows exist — resolve before running)
ALTER TABLE "agent_logs" ALTER COLUMN "userId" SET NOT NULL;
