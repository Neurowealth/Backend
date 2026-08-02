-- Rollback for 20260718000000_add_referral_program
-- Drops the referral tables and the ReferralStatus enum.
-- WARNING: Destroys all referral codes and conversion/payout tracking history.
--
-- NOTE: The 'REFERRAL_REWARD' value added to the "TransactionType" enum is NOT
-- removed. PostgreSQL cannot drop a single enum value, and any Transaction rows
-- already written with that type would be orphaned. The value is left in place;
-- it is inert once the referral tables are gone.

ALTER TABLE "referral_conversions" DROP CONSTRAINT IF EXISTS "referral_conversions_referredUserId_fkey";

ALTER TABLE "referral_conversions" DROP CONSTRAINT IF EXISTS "referral_conversions_referralCodeId_fkey";

ALTER TABLE "referral_codes" DROP CONSTRAINT IF EXISTS "referral_codes_ownerUserId_fkey";

DROP TABLE IF EXISTS "referral_conversions";

DROP TABLE IF EXISTS "referral_codes";

DROP TYPE IF EXISTS "ReferralStatus";
