-- rollback.sql — reverse of 20260830120000_add_rebalance_decisions/migration.sql
-- Drops the explainable rebalance decisions ledger (#343).
-- WARNING: DATA LOSS — all REBALANCED|HELD|BLOCKED rationale history is lost.
-- Indexes are dropped with the table (explicit drops for idempotency).
-- Safe to run multiple times. Revert app code BEFORE running.
-- Drain: ensure no PENDING outbox ops depend on rebalance decisions.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260830120000_add_rebalance_decisions/rollback.sql

DROP INDEX IF EXISTS "rebalance_decisions_outcome_createdAt_idx";
DROP INDEX IF EXISTS "rebalance_decisions_batchKey_outcome_createdAt_idx";
DROP INDEX IF EXISTS "rebalance_decisions_fromProtocol_createdAt_idx";
DROP INDEX IF EXISTS "rebalance_decisions_correlationId_idx";
DROP TABLE IF EXISTS "rebalance_decisions" CASCADE;
