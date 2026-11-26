-- Rollback for 20261027030000_add_referral_vesting_clawback

DROP INDEX IF EXISTS "referral_clawbacks_status_expiresAt_idx";
DROP INDEX IF EXISTS "referral_clawbacks_conversionId_idx";
DROP INDEX IF EXISTS "referral_clawbacks_referrerUserId_status_idx";
DROP TABLE IF EXISTS "referral_clawbacks";

DROP INDEX IF EXISTS "referral_reward_tranches_conversionId_idx";
DROP INDEX IF EXISTS "referral_reward_tranches_status_vestsAt_idx";
DROP INDEX IF EXISTS "referral_reward_tranches_conversionId_leg_seq_key";
DROP TABLE IF EXISTS "referral_reward_tranches";
