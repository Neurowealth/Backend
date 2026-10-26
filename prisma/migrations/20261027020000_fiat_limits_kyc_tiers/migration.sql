-- CreateEnum
CREATE TYPE "KycTier" AS ENUM ('TIER_0', 'TIER_1', 'TIER_2', 'TIER_3');

-- CreateTable
CREATE TABLE "kyc_profiles" (
    "userId" TEXT NOT NULL,
    "tier" "KycTier" NOT NULL DEFAULT 'TIER_0',
    "providerRef" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "fiat_limit_policies" (
    "tier" "KycTier" NOT NULL,
    "perTxnMax" DECIMAL(36,18) NOT NULL,
    "dailyMax" DECIMAL(36,18) NOT NULL,
    "monthlyMax" DECIMAL(36,18) NOT NULL,
    "maxTxnsPerHour" INTEGER NOT NULL,
    "maxTxnsPerDay" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "offRampOverrides" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiat_limit_policies_pkey" PRIMARY KEY ("tier")
);

-- AddForeignKey
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed default tier policies (#362)
INSERT INTO "fiat_limit_policies" ("tier", "perTxnMax", "dailyMax", "monthlyMax", "maxTxnsPerHour", "maxTxnsPerDay", "currency", "offRampOverrides", "updatedAt")
VALUES
    ('TIER_0', 0, 0, 0, 0, 0, 'USD', NULL, CURRENT_TIMESTAMP),
    ('TIER_1', 1000, 2500, 10000, 3, 10, 'USD', '{"perTxnMax":500,"dailyMax":1000,"monthlyMax":5000}', CURRENT_TIMESTAMP),
    ('TIER_2', 10000, 25000, 100000, 5, 20, 'USD', '{"perTxnMax":5000,"dailyMax":15000,"monthlyMax":50000}', CURRENT_TIMESTAMP),
    ('TIER_3', 50000, 100000, 500000, 10, 50, 'USD', '{"perTxnMax":25000,"dailyMax":50000,"monthlyMax":250000}', CURRENT_TIMESTAMP)
ON CONFLICT ("tier") DO NOTHING;
