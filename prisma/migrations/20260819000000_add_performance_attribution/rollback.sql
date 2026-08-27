-- Rollback for 20260819000000_add_performance_attribution
-- Drops the performance-attribution tables (#320).
--
-- Safe to run before or after deploying the reverted application code: both
-- tables are read-only through src/routes/analytics.ts and the marketplace
-- mapper, and both are written only by src/jobs/attribution.ts. Removing them
-- makes GET /api/v1/analytics/attribution start returning 404/empty and drops
-- `vsBenchmark` from marketplace entries; no other feature reads these tables
-- and no funds or positions are affected.

ALTER TABLE "strategy_attributions" DROP CONSTRAINT IF EXISTS "strategy_attributions_publishedStrategyId_fkey";

ALTER TABLE "portfolio_attributions" DROP CONSTRAINT IF EXISTS "portfolio_attributions_userId_fkey";

DROP TABLE IF EXISTS "strategy_attributions";

DROP TABLE IF EXISTS "portfolio_attributions";
