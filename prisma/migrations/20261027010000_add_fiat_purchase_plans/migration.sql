-- CreateTable
CREATE TABLE "fiat_purchase_plans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fiatAmount" DECIMAL(36,18) NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "paymentMethodRef" TEXT NOT NULL,
    "cadence" "DepositCadence" NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "status" "RecurringDepositPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "autoDeposit" BOOLEAN NOT NULL DEFAULT true,
    "maxSlippagePct" DECIMAL(6,4),
    "baselineRate" DECIMAL(36,18),
    "retryPolicy" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunFiatOrderId" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "autoPauseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiat_purchase_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiat_purchase_plan_runs" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "nextRetryAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "fiatAmount" DECIMAL(36,18) NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "baselineRate" DECIMAL(36,18),
    "liveQuoteRate" DECIMAL(36,18),
    "quotedCryptoAmount" DECIMAL(36,18),
    "settledCryptoAmount" DECIMAL(36,18),
    "fiatOrderId" TEXT,
    "fiatOrderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "depositTxId" TEXT,
    "depositTxHash" TEXT,
    "actionRequiredUrl" TEXT,
    "actionExpiresAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiat_purchase_plan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiat_purchase_plans_userId_idx" ON "fiat_purchase_plans"("userId");

-- CreateIndex
CREATE INDEX "fiat_purchase_plans_status_nextRunAt_idx" ON "fiat_purchase_plans"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "fiat_purchase_plan_runs_planId_scheduledFor_key" ON "fiat_purchase_plan_runs"("planId", "scheduledFor");

-- CreateIndex
CREATE INDEX "fiat_purchase_plan_runs_planId_createdAt_idx" ON "fiat_purchase_plan_runs"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "fiat_purchase_plan_runs_userId_idx" ON "fiat_purchase_plan_runs"("userId");

-- CreateIndex
CREATE INDEX "fiat_purchase_plan_runs_status_idx" ON "fiat_purchase_plan_runs"("status");

-- CreateIndex
CREATE INDEX "fiat_purchase_plan_runs_fiatOrderId_idx" ON "fiat_purchase_plan_runs"("fiatOrderId");

-- AddForeignKey
ALTER TABLE "fiat_purchase_plans" ADD CONSTRAINT "fiat_purchase_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiat_purchase_plan_runs" ADD CONSTRAINT "fiat_purchase_plan_runs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "fiat_purchase_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiat_purchase_plan_runs" ADD CONSTRAINT "fiat_purchase_plan_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
