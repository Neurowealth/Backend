-- rollback.sql — reverse of 20260928170000_soft_delete_alert_rules/migration.sql
-- Removes alert-rule soft deletion and lifecycle audit storage.
DROP TABLE IF EXISTS "user_data_audits";

DROP INDEX IF EXISTS "alert_rules_userId_deletedAt_idx";
ALTER TABLE "alert_rules" DROP COLUMN IF EXISTS "deletedAt";
CREATE INDEX IF NOT EXISTS "alert_rules_userId_idx" ON "alert_rules"("userId");