-- Referral rewards program (single-level). Adds referral codes + conversion
-- lifecycle tracking and a distinct REFERRAL_REWARD transaction type.

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'REFERRAL_REWARD';

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'ACTIVATED', 'REWARDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_conversions" (
    "id" TEXT NOT NULL,
    "referralCodeId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "activationTxId" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "ownerRewardTxId" TEXT,
    "referredRewardTxId" TEXT,
    "payoutError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_ownerUserId_key" ON "referral_codes"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_code_idx" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referral_conversions_referredUserId_key" ON "referral_conversions"("referredUserId");

-- CreateIndex
CREATE INDEX "referral_conversions_referralCodeId_idx" ON "referral_conversions"("referralCodeId");

-- CreateIndex
CREATE INDEX "referral_conversions_status_idx" ON "referral_conversions"("status");

-- CreateIndex
CREATE INDEX "referral_conversions_createdAt_idx" ON "referral_conversions"("createdAt");

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_conversions" ADD CONSTRAINT "referral_conversions_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "referral_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_conversions" ADD CONSTRAINT "referral_conversions_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
