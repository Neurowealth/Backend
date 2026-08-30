-- Migration: add_rebalance_decisions (#343)
-- Explainable rebalance decisions with a per-decision rationale ledger.
-- One row per (protocol, strategy, follow) batch evaluation per tick, written
-- whether or not a rebalance fired (REBALANCED | HELD | BLOCKED).

CREATE TABLE "rebalance_decisions" (
    "id"                 TEXT NOT NULL,
    "correlationId"      TEXT NOT NULL,
    "batchKey"           TEXT NOT NULL,
    "fromProtocol"       TEXT NOT NULL,
    "toProtocol"         TEXT,
    "outcome"            TEXT NOT NULL,
    "blockedReason"      TEXT,
    "strategyName"       TEXT,
    "strategyIsFollowed" BOOLEAN NOT NULL DEFAULT false,
    "followedStrategyId" TEXT,
    "thresholds"         JSONB NOT NULL,
    "currentApy"         DECIMAL(12, 6),
    "chosenApy"          DECIMAL(12, 6),
    "rawImprovement"     DECIMAL(12, 6),
    "estCostPercent"     DECIMAL(12, 6),
    "netImprovement"     DECIMAL(12, 6),
    "candidates"         JSONB NOT NULL,
    "rationale"          TEXT,
    "affectedUserIds"    TEXT[] NOT NULL,
    "affectedPositions"  INTEGER NOT NULL,
    "outboxOpId"         TEXT,
    "heldSince"          TIMESTAMP(3),
    "lastEvaluatedAt"    TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rebalance_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rebalance_decisions_correlationId_idx" ON "rebalance_decisions"("correlationId");
CREATE INDEX "rebalance_decisions_fromProtocol_createdAt_idx" ON "rebalance_decisions"("fromProtocol", "createdAt");
CREATE INDEX "rebalance_decisions_batchKey_outcome_createdAt_idx" ON "rebalance_decisions"("batchKey", "outcome", "createdAt");
CREATE INDEX "rebalance_decisions_outcome_createdAt_idx" ON "rebalance_decisions"("outcome", "createdAt");
