-- Rollback for 20260725000000_add_strategy_marketplace
-- Drops the strategy marketplace tables (#285).
--
-- WARNING: Destroys every published strategy, every follow relationship, and
-- every precomputed leaderboard metric. Followers' agents revert to their own
-- User.rebalanceStrategy / User.strategyConfig on the next scheduled run —
-- no funds are moved by this rollback, but a follower's rebalance decisions
-- WILL change on the next tick. Announce before running in production.
--
-- Safe to run before or after deploying the reverted application code: the
-- application only reads these tables through src/strategy/service.ts and
-- src/agent/loop.ts, both of which treat "no follow" as the default path.

ALTER TABLE "published_strategy_metrics" DROP CONSTRAINT IF EXISTS "published_strategy_metrics_publishedStrategyId_fkey";

ALTER TABLE "strategy_follows" DROP CONSTRAINT IF EXISTS "strategy_follows_publishedStrategyId_fkey";

ALTER TABLE "strategy_follows" DROP CONSTRAINT IF EXISTS "strategy_follows_followerUserId_fkey";

ALTER TABLE "published_strategies" DROP CONSTRAINT IF EXISTS "published_strategies_userId_fkey";

DROP INDEX IF EXISTS "strategy_follows_active_follower_key";

DROP TABLE IF EXISTS "published_strategy_metrics";

DROP TABLE IF EXISTS "strategy_follows";

DROP TABLE IF EXISTS "published_strategies";
