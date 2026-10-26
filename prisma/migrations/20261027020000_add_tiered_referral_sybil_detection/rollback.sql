-- Rollback for 20261027020000_add_tiered_referral_sybil_detection

DROP INDEX IF EXISTS "referral_reward_schedules_isActive_idx";
DROP INDEX IF EXISTS "referral_reward_schedules_scheduleVersion_key";
DROP TABLE IF EXISTS "referral_reward_schedules";

DROP INDEX IF EXISTS "referral_conversions_holdUntil_idx";
DROP INDEX IF EXISTS "referral_conversions_payoutHold_idx";

ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "reviewNote";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "holdUntil";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "payoutHold";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "abuseModelVersion";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "abuseReasons";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "abuseRiskScore";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "capReason";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "rewardCapped";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "calculatedReferredReward";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "calculatedOwnerReward";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "qualifyingDepositAmount";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "referrerMilestoneTier";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "scheduleVersion";
