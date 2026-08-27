-- rollback.sql — reverse of 20260529000001_add_custodial_wallets/migration.sql
-- Drops the custodial_wallets table and all its indexes.

DROP TABLE IF EXISTS "custodial_wallets" CASCADE;
