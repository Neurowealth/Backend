-- Migration: 20261027030000_add_referral_vesting_clawback
-- Description: Referral reward vesting tranches and early-withdrawal clawback (#364)

CREATE TABLE IF NOT EXISTS "referral_reward_tranches" (
    "id" TEXT NOT NULL,
    "conversionId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "vestsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requiresBalanceAtLeast" DECIMAL(36,18) NOT NULL,
    "outboxOpId" TEXT,
    "paidTxHash" TEXT,
    "rewardTxId" TEXT,
    "payoutError" TEXT,
    "forfeitReason" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_reward_tranches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "referral_reward_tranches_conversionId_fkey"
      FOREIGN KEY ("conversionId") REFERENCES "referral_conversions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_reward_tranches_conversionId_leg_seq_key"
  ON "referral_reward_tranches"("conversionId", "leg", "seq");

CREATE INDEX IF NOT EXISTS "referral_reward_tranches_status_vestsAt_idx"
  ON "referral_reward_tranches"("status", "vestsAt");

CREATE INDEX IF NOT EXISTS "referral_reward_tranches_conversionId_idx"
  ON "referral_reward_tranches"("conversionId");

CREATE TABLE IF NOT EXISTS "referral_clawbacks" (
    "id" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "conversionId" TEXT NOT NULL,
    "trancheId" TEXT,
    "originalAmount" DECIMAL(36,18) NOT NULL,
    "remainingAmount" DECIMAL(36,18) NOT NULL,
    "offsetApplied" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "writtenOffAmount" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_clawbacks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "referral_clawbacks_conversionId_fkey"
      FOREIGN KEY ("conversionId") REFERENCES "referral_conversions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "referral_clawbacks_referrerUserId_status_idx"
  ON "referral_clawbacks"("referrerUserId", "status");

CREATE INDEX IF NOT EXISTS "referral_clawbacks_conversionId_idx"
  ON "referral_clawbacks"("conversionId");

CREATE INDEX IF NOT EXISTS "referral_clawbacks_status_expiresAt_idx"
  ON "referral_clawbacks"("status", "expiresAt");
