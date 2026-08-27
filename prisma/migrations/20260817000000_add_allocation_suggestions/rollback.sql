-- Rollback for 20260817000000_add_allocation_suggestions
-- Drops the portfolio-optimization suggestion history (#322).
--
-- WARNING: Destroys every stored allocation suggestion and its efficient
-- frontier / backtest comparison. This is advisory data ONLY — no funds, no
-- keys, and no agent behaviour depend on it. AllocationSuggestion is never read
-- by the agent loop: src/agent/loop.ts reads User.strategyConfig, which this
-- feature is structurally forbidden from writing (see the structural test in
-- tests/unit/analytics/structural.test.ts). Dropping this table therefore
-- cannot move money or change a single rebalance decision; users simply lose
-- their suggestion history and the next run recomputes from scratch.
--
-- Safe to run before or after deploying the reverted application code. The
-- table is written only by src/analytics/service.ts and read only by
-- GET /api/v1/portfolio/:userId/suggestions; both are removed by the revert.
-- If the table is dropped while the new code is still live, that endpoint
-- errors but nothing else in the application is affected.

ALTER TABLE "allocation_suggestions" DROP CONSTRAINT IF EXISTS "allocation_suggestions_userId_fkey";

DROP INDEX IF EXISTS "allocation_suggestions_userId_inputHash_idx";

DROP INDEX IF EXISTS "allocation_suggestions_userId_computedAt_idx";

DROP TABLE IF EXISTS "allocation_suggestions";
