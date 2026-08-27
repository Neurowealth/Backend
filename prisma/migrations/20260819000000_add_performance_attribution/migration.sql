-- Performance attribution & benchmark-relative return reporting (#320).
--
-- Adds two precomputed-metric tables, one row per (subject, windowDays),
-- mirroring published_strategy_metrics: the API and the marketplace read
-- these rows rather than recomputing a window's worth of daily YieldSnapshot +
-- ProtocolRate history on every request. All the math lives in
-- src/analytics/attribution.ts (pure, zero I/O); src/jobs/attribution.ts is
-- the only thing that writes these tables.
--
-- "sectorBreakdown" is JSONB rather than a child table on purpose: it is
-- small (bounded by the protocol universe), never filtered/sorted on its own,
-- and always read as a whole alongside the row that owns it — same precedent
-- as allocation_suggestions."weights"/"frontier".

-- CreateTable
CREATE TABLE "portfolio_attributions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "portfolioReturn" DOUBLE PRECISION NOT NULL,
    "benchmarkReturn" DOUBLE PRECISION NOT NULL,
    "allocationEffect" DOUBLE PRECISION NOT NULL,
    "selectionEffect" DOUBLE PRECISION NOT NULL,
    "unattributedEffect" DOUBLE PRECISION NOT NULL,
    "reconciliationGap" DOUBLE PRECISION NOT NULL,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "benchmarkVersion" TEXT NOT NULL,
    "sectorBreakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_attributions" (
    "id" TEXT NOT NULL,
    "publishedStrategyId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "portfolioReturn" DOUBLE PRECISION NOT NULL,
    "benchmarkReturn" DOUBLE PRECISION NOT NULL,
    "allocationEffect" DOUBLE PRECISION NOT NULL,
    "selectionEffect" DOUBLE PRECISION NOT NULL,
    "unattributedEffect" DOUBLE PRECISION NOT NULL,
    "reconciliationGap" DOUBLE PRECISION NOT NULL,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "benchmarkVersion" TEXT NOT NULL,
    "sectorBreakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portfolio_attributions_userId_idx" ON "portfolio_attributions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_attributions_userId_windowDays_key" ON "portfolio_attributions"("userId", "windowDays");

-- CreateIndex
CREATE INDEX "strategy_attributions_publishedStrategyId_idx" ON "strategy_attributions"("publishedStrategyId");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_attributions_publishedStrategyId_windowDays_key" ON "strategy_attributions"("publishedStrategyId", "windowDays");

-- AddForeignKey
ALTER TABLE "portfolio_attributions" ADD CONSTRAINT "portfolio_attributions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_attributions" ADD CONSTRAINT "strategy_attributions_publishedStrategyId_fkey" FOREIGN KEY ("publishedStrategyId") REFERENCES "published_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
