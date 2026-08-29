-- Add TREASURY_SWEEP to OutboxOpKind enum
ALTER TYPE "OutboxOpKind" ADD VALUE 'TREASURY_SWEEP';

-- Create TreasuryTier enum
CREATE TYPE "TreasuryTier" AS ENUM ('HOT', 'WARM', 'COLD');

-- Create TreasuryAccount table
CREATE TABLE "treasury_accounts" (
    "id" TEXT NOT NULL,
    "tier" "TreasuryTier" NOT NULL,
    "publicKey" TEXT NOT NULL UNIQUE,
    "signerScheme" TEXT NOT NULL,
    "targetLowXlm" DECIMAL(36,18) NOT NULL,
    "targetHighXlm" DECIMAL(36,18) NOT NULL,
    "assetPolicy" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_accounts_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "treasury_accounts_tier_idx" ON "treasury_accounts"("tier");
CREATE INDEX "treasury_accounts_isActive_idx" ON "treasury_accounts"("isActive");

-- Create TreasurySweep table
CREATE TABLE "treasury_sweeps" (
    "id" TEXT NOT NULL,
    "fromTier" "TreasuryTier" NOT NULL,
    "toTier" "TreasuryTier" NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "outboxOpId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "treasury_sweeps_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "treasury_sweeps_status_idx" ON "treasury_sweeps"("status");
CREATE INDEX "treasury_sweeps_fromTier_idx" ON "treasury_sweeps"("fromTier");
CREATE INDEX "treasury_sweeps_toTier_idx" ON "treasury_sweeps"("toTier");

-- Create MultisigEnvelope table
CREATE TABLE "multisig_envelopes" (
    "id" TEXT NOT NULL,
    "sweepId" TEXT,
    "publicKey" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "signatures" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "multisig_envelopes_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "multisig_envelopes_status_idx" ON "multisig_envelopes"("status");
CREATE INDEX "multisig_envelopes_expiresAt_idx" ON "multisig_envelopes"("expiresAt");
