-- Rollback for 20260830163707_add_referral_fraud_review
-- Drops the fraud/review columns added to referral_conversions.
--
-- NOTE: The 'FLAGGED' value added to the "ReferralStatus" enum is NOT
-- removed. PostgreSQL cannot drop a single enum value, and any
-- ReferralConversion rows already written with that status would be
-- orphaned. The value is left in place; it is inert once nothing writes it.

ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "fraudReasons";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "flaggedAt";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "reviewedAt";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "reviewedBy";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "reviewDecision";
