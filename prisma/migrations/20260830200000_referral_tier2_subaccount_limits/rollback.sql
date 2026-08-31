ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "tier2RewardTxId";
ALTER TABLE "sub_accounts" DROP COLUMN IF EXISTS "transactionLimit";
ALTER TABLE "sub_accounts" DROP COLUMN IF EXISTS "dailyLimit";
