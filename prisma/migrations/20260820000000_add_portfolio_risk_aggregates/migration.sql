-- Migration: add_portfolio_risk_aggregates
-- Creates the portfolio_risk_aggregates table for precomputed per-user
-- risk metrics (VaR, CVaR, Sortino, drawdown, volatility).
-- Written by src/jobs/portfolioRisk.ts on a configurable schedule.

CREATE TABLE "portfolio_risk_aggregates" (
    "id"                    TEXT NOT NULL,
    "userId"                TEXT NOT NULL,
    "window"                TEXT NOT NULL,
    "insufficientHistory"   BOOLEAN NOT NULL DEFAULT false,
    "sampleCount"           INTEGER NOT NULL DEFAULT 0,
    "annualisedVolatility"  DECIMAL(20, 8),
    "sortinoRatio"          DECIMAL(20, 8),
    "downsideDeviation"     DECIMAL(20, 8),
    "maxDrawdown"           DECIMAL(20, 8),
    "maxDrawdownDuration"   INTEGER,
    "varHistorical95"       DECIMAL(20, 8),
    "varHistorical99"       DECIMAL(20, 8),
    "varParametric95"       DECIMAL(20, 8),
    "varParametric99"       DECIMAL(20, 8),
    "cvarHistorical95"      DECIMAL(20, 8),
    "cvarHistorical99"      DECIMAL(20, 8),
    "beta"                  DECIMAL(20, 8),
    "dataFrom"              TIMESTAMP(3),
    "dataTo"                TIMESTAMP(3),
    "computedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_risk_aggregates_pkey" PRIMARY KEY ("id")
);

-- Foreign key to users
ALTER TABLE "portfolio_risk_aggregates"
    ADD CONSTRAINT "portfolio_risk_aggregates_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique constraint: one row per (userId, window) — upserted on each compute run
CREATE UNIQUE INDEX "portfolio_risk_aggregates_userId_window_key"
    ON "portfolio_risk_aggregates"("userId", "window");

-- Indexes for efficient lookups and leaderboard ORDER BY
CREATE INDEX "portfolio_risk_aggregates_userId_idx"           ON "portfolio_risk_aggregates"("userId");
CREATE INDEX "portfolio_risk_aggregates_window_idx"           ON "portfolio_risk_aggregates"("window");
CREATE INDEX "portfolio_risk_aggregates_computedAt_idx"       ON "portfolio_risk_aggregates"("computedAt");
CREATE INDEX "portfolio_risk_aggregates_sortinoRatio_idx"     ON "portfolio_risk_aggregates"("sortinoRatio");
CREATE INDEX "portfolio_risk_aggregates_annualisedVol_idx"    ON "portfolio_risk_aggregates"("annualisedVolatility");
