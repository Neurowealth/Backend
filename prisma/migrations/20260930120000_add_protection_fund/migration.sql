-- #533 Protocol-Risk Protection Fund / Deposit Insurance.
--
-- Four new tables for the protection fund: balance tracking, contribution
-- ledger, coverage events, and per-user claims. All additive.

CREATE TABLE "protection_fund_balances" (
    "id" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOTSTRAP',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protection_fund_balances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "protection_fund_balances_assetSymbol_key"
ON "protection_fund_balances"("assetSymbol");

CREATE TABLE "protection_fund_contributions" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "sourceRef" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protection_fund_contributions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "protection_fund_contributions_createdAt_idx"
ON "protection_fund_contributions"("createdAt");

CREATE TABLE "coverage_events" (
    "id" TEXT NOT NULL,
    "protocolName" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "lossWindowStart" TEXT NOT NULL,
    "lossWindowEnd" TEXT NOT NULL,
    "totalPlatformExposure" DECIMAL(36,18) NOT NULL,
    "declaredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedBy" TEXT,
    "coverageTerms" JSONB,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coverage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "coverage_events_protocolName_status_idx"
ON "coverage_events"("protocolName", "status");

CREATE INDEX "coverage_events_status_idx"
ON "coverage_events"("status");

CREATE TABLE "coverage_claims" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "actualLoss" DECIMAL(36,18) NOT NULL,
    "netLoss" DECIMAL(36,18) NOT NULL,
    "payoutAmount" DECIMAL(36,18) NOT NULL,
    "coverageType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outboxOpId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coverage_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coverage_claims_eventId_positionId_key"
ON "coverage_claims"("eventId", "positionId");

CREATE INDEX "coverage_claims_userId_status_idx"
ON "coverage_claims"("userId", "status");

CREATE INDEX "coverage_claims_eventId_status_idx"
ON "coverage_claims"("eventId", "status");

ALTER TABLE "coverage_claims"
ADD CONSTRAINT "coverage_claims_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "coverage_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coverage_claims"
ADD CONSTRAINT "coverage_claims_positionId_fkey"
FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
