-- Rollback for 20260626224106_add_key_version_to_wallet
-- Reverses the admin API key / audit log tables, the wallet keyVersion column,
-- and the indexes added by the forward migration. Also restores the
-- dead_letter_events composite index the forward migration dropped.
-- WARNING: Destroys admin API keys and the admin audit trail.

-- DropForeignKey
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT IF EXISTS "admin_audit_logs_adminKeyId_fkey";

-- DropIndex (created by forward migration)
DROP INDEX IF EXISTS "yield_snapshots_positionId_snapshotAt_idx";
DROP INDEX IF EXISTS "protocol_rates_protocolName_assetSymbol_fetchedAt_idx";
DROP INDEX IF EXISTS "custodial_wallets_keyVersion_idx";

-- DropTable (indexes drop with their table)
DROP TABLE IF EXISTS "admin_audit_logs";
DROP TABLE IF EXISTS "admin_api_keys";

-- DropColumn
ALTER TABLE "custodial_wallets" DROP COLUMN IF EXISTS "keyVersion";

-- Recreate the index the forward migration dropped
CREATE INDEX IF NOT EXISTS "dead_letter_events_status_createdAt_idx" ON "dead_letter_events"("status", "createdAt");
