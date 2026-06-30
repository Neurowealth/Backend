-- Rollback for 20260617000000_fix_agent_log_attribution
-- Reverses the agent_logs attribution changes.
--
-- PARTIALLY IRREVERSIBLE: the forward migration relaxed agent_logs.userId to
-- nullable so system-level scans could log without a user. Restoring NOT NULL
-- will FAIL if any rows have userId IS NULL. Reassign or delete those rows
-- before running this rollback, e.g.:
--   DELETE FROM "agent_logs" WHERE "userId" IS NULL;

DROP INDEX IF EXISTS "agent_logs_userId_createdAt_idx";
DROP INDEX IF EXISTS "agent_logs_positionId_idx";

ALTER TABLE "agent_logs" DROP COLUMN IF EXISTS "positionId";

ALTER TABLE "agent_logs" ALTER COLUMN "userId" SET NOT NULL;
