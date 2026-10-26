-- Migration: 20261027020000_add_tiered_referral_sybil_detection
-- Adds ReferralRewardSchedule and tiered/Sybil fields on referral_conversions (#363).

ALTER TABLE "referral_conversions"
  ADD COLUMN IF NOT EXISTS "scheduleVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "referrerMilestoneTier" TEXT,
  ADD COLUMN IF NOT EXISTS "qualifyingDepositAmount" DECIMAL(36, 18),
  ADD COLUMN IF NOT EXISTS "calculatedOwnerReward" DECIMAL(36, 18),
  ADD COLUMN IF NOT EXISTS "calculatedReferredReward" DECIMAL(36, 18),
  ADD COLUMN IF NOT EXISTS "rewardCapped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "capReason" TEXT,
  ADD COLUMN IF NOT EXISTS "abuseRiskScore" INTEGER,
  ADD COLUMN IF NOT EXISTS "abuseReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "abuseModelVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutHold" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "holdUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;

CREATE INDEX IF NOT EXISTS "referral_conversions_payoutHold_idx" ON "referral_conversions"("payoutHold");
CREATE INDEX IF NOT EXISTS "referral_conversions_holdUntil_idx" ON "referral_conversions"("holdUntil");

CREATE TABLE IF NOT EXISTS "referral_reward_schedules" (
  "id" TEXT NOT NULL,
  "scheduleVersion" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "depositTiers" JSONB NOT NULL,
  "milestoneTiers" JSONB NOT NULL,
  "maxRewardPerConversion" DECIMAL(36, 18) NOT NULL,
  "maxRewardPerReferrerPerMonth" DECIMAL(36, 18) NOT NULL,
  "minHoldWindowHours" INTEGER NOT NULL DEFAULT 168,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referral_reward_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_reward_schedules_scheduleVersion_key"
  ON "referral_reward_schedules"("scheduleVersion");
CREATE INDEX IF NOT EXISTS "referral_reward_schedules_isActive_idx"
  ON "referral_reward_schedules"("isActive");
