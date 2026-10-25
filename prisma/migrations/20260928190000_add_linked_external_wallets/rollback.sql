-- rollback.sql — reverse of 20260928190000_add_linked_external_wallets/migration.sql
-- Removes linked external wallet snapshots and the opt-in goal column.
ALTER TABLE IF EXISTS "linked_external_wallets"
DROP CONSTRAINT IF EXISTS "linked_external_wallets_userId_fkey";

DROP TABLE IF EXISTS "linked_external_wallets";

ALTER TABLE "savings_goals"
DROP COLUMN IF EXISTS "includeExternalHoldings";