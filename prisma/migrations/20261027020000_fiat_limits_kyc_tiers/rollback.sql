-- Rollback for 20261027020000_fiat_limits_kyc_tiers
ALTER TABLE "kyc_profiles" DROP CONSTRAINT IF EXISTS "kyc_profiles_userId_fkey";
DROP TABLE IF EXISTS "fiat_limit_policies";
DROP TABLE IF EXISTS "kyc_profiles";
DROP TYPE IF EXISTS "KycTier";
