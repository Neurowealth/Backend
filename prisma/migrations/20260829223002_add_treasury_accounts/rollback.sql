-- Rollback: Remove treasury account tables and types
DROP TABLE IF EXISTS "multisig_envelopes";
DROP TABLE IF EXISTS "treasury_sweeps";
DROP TABLE IF EXISTS "treasury_accounts";
DROP TYPE IF EXISTS "TreasuryTier";

-- Note: PostgreSQL doesn't support removing enum values directly
-- This would require recreating the enum type in production
