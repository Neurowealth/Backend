-- rollback.sql — reverse of 20260820000000_add_portfolio_risk_aggregates/migration.sql
--
-- Drops the portfolio_risk_aggregates table and all its indexes.
-- Safe to run multiple times (IF EXISTS guards).
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260820000000_add_portfolio_risk_aggregates/rollback.sql

-- Drop indexes first (dropped implicitly with the table, listed explicitly for clarity)
DROP INDEX IF EXISTS "portfolio_risk_aggregates_annualisedVol_idx";
DROP INDEX IF EXISTS "portfolio_risk_aggregates_sortinoRatio_idx";
DROP INDEX IF EXISTS "portfolio_risk_aggregates_computedAt_idx";
DROP INDEX IF EXISTS "portfolio_risk_aggregates_window_idx";
DROP INDEX IF EXISTS "portfolio_risk_aggregates_userId_idx";
DROP INDEX IF EXISTS "portfolio_risk_aggregates_userId_window_key";

-- Drop the table (cascade removes foreign-key constraint automatically)
DROP TABLE IF EXISTS "portfolio_risk_aggregates" CASCADE;
