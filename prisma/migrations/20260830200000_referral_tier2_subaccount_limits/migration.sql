ALTER TABLE "sub_accounts" ADD COLUMN "dailyLimit" DECIMAL(36,18), ADD COLUMN "transactionLimit" DECIMAL(36,18);
ALTER TABLE "referral_conversions" ADD COLUMN "tier2RewardTxId" TEXT;
