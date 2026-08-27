-- Strategy marketplace / opt-in copy-trading (#285).
--
-- Adds three tables so a user can publish an anonymized snapshot of their agent
-- *configuration* and others can follow it. Configuration only — no table here
-- references a wallet, a key, or a balance, and there is deliberately no column
-- linking a follow to the publisher's custody.
--
-- Two schema decisions worth reading before altering this:
--
-- 1. strategy_follows."publishedStrategyId" is NULLABLE with ON DELETE SET NULL,
--    and carries its own "appliedConfig" snapshot. A follower must keep running
--    on their last-applied config when the publisher unpublishes or deletes
--    their account; cascading the follow away would silently change what the
--    agent does with the follower's money.
--
-- 2. "At most one active follow per user" is a PARTIAL unique index. Prisma
--    cannot express partial uniques, so it is created by hand below and is the
--    structural backstop behind the service-layer swap-in-a-transaction.

-- CreateTable
CREATE TABLE "published_strategies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "strategyConfig" JSONB NOT NULL,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "published_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_follows" (
    "id" TEXT NOT NULL,
    "followerUserId" TEXT NOT NULL,
    "publishedStrategyId" TEXT,
    "appliedConfig" JSONB NOT NULL,
    "appliedConfigVersion" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unfollowedAt" TIMESTAMP(3),

    CONSTRAINT "strategy_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_strategy_metrics" (
    "id" TEXT NOT NULL,
    "publishedStrategyId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "apy" DOUBLE PRECISION NOT NULL,
    "sharpe" DOUBLE PRECISION,
    "sampleCount" INTEGER NOT NULL,
    "trackRecordDays" INTEGER NOT NULL,
    "isEligible" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_strategy_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "published_strategies_userId_key" ON "published_strategies"("userId");

-- CreateIndex
CREATE INDEX "published_strategies_isPublished_idx" ON "published_strategies"("isPublished");

-- CreateIndex
CREATE INDEX "strategy_follows_followerUserId_unfollowedAt_idx" ON "strategy_follows"("followerUserId", "unfollowedAt");

-- CreateIndex
CREATE INDEX "strategy_follows_publishedStrategyId_unfollowedAt_idx" ON "strategy_follows"("publishedStrategyId", "unfollowedAt");

-- CreateIndex
CREATE UNIQUE INDEX "published_strategy_metrics_publishedStrategyId_windowDays_key" ON "published_strategy_metrics"("publishedStrategyId", "windowDays");

-- CreateIndex
CREATE INDEX "published_strategy_metrics_windowDays_isEligible_sharpe_idx" ON "published_strategy_metrics"("windowDays", "isEligible", "sharpe");

-- CreateIndex
CREATE INDEX "published_strategy_metrics_windowDays_isEligible_apy_idx" ON "published_strategy_metrics"("windowDays", "isEligible", "apy");

-- CreateIndex
-- Partial unique index: at most one ACTIVE follow per user. Not expressible in
-- schema.prisma; the service layer swaps follows inside a transaction and this
-- is the structural guarantee behind it.
CREATE UNIQUE INDEX "strategy_follows_active_follower_key"
    ON "strategy_follows"("followerUserId") WHERE "unfollowedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "published_strategies" ADD CONSTRAINT "published_strategies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_follows" ADD CONSTRAINT "strategy_follows_followerUserId_fkey" FOREIGN KEY ("followerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_follows" ADD CONSTRAINT "strategy_follows_publishedStrategyId_fkey" FOREIGN KEY ("publishedStrategyId") REFERENCES "published_strategies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_strategy_metrics" ADD CONSTRAINT "published_strategy_metrics_publishedStrategyId_fkey" FOREIGN KEY ("publishedStrategyId") REFERENCES "published_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
