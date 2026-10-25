CREATE TABLE "treasury_sweep_policies" (
  "id" TEXT NOT NULL,
  "fromTier" "TreasuryTier" NOT NULL,
  "toTier" "TreasuryTier" NOT NULL,
  "maxHotBalance" DECIMAL(36,18) NOT NULL,
  "sweepIntervalMinutes" INTEGER NOT NULL,
  "minSweepAmount" DECIMAL(36,18) NOT NULL,
  "requiresApprovalAbove" DECIMAL(36,18),
  "version" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasury_sweep_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "treasury_sweep_policies_from_to_active_idx" ON "treasury_sweep_policies"("fromTier", "toTier", "isActive");
