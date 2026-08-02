-- Rollback for 20260529000001_add_custodial_wallets
-- Drops the custodial wallets table (indexes drop with it).
-- WARNING: Destroys encrypted custodial wallet secrets. Ensure keys are backed up.

DROP TABLE IF EXISTS "custodial_wallets";
