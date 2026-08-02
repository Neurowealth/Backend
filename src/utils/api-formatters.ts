export const mapTransactionToResponse = (tx: any) => ({
  id: tx.id,
  txHash: tx.txHash,
  type: tx.type,
  status: tx.status,
  amount: Number(tx.amount),
  assetSymbol: tx.assetSymbol,
  protocolName: tx.protocolName,
  createdAt: tx.createdAt.toISOString(),
})

export const mapPositionToResponse = (position: any) => ({
  id: position.id,
  protocolName: position.protocolName,
  assetSymbol: position.assetSymbol,
  currentValue: Number(position.currentValue),
  yieldEarned: Number(position.yieldEarned),
  status: position.status,
})

/**
 * Strategy marketplace (#285) — layer 2 of the anonymization boundary.
 *
 * Hand-written allowlists, deliberately never a spread. The query layer in
 * src/strategy/service.ts already refuses to select `userId`; these mappers are
 * the second independent barrier, so adding a field to a select does not
 * silently publish it. If you add a key here, ask first whether it identifies
 * the publisher.
 */

/** One leaderboard row: config + derived stats, never absolute balances. */
export const mapMarketplaceEntryToResponse = (metric: any) => ({
  strategyId: metric.publishedStrategy.id,
  label: metric.publishedStrategy.label,
  strategyConfig: metric.publishedStrategy.strategyConfig,
  configVersion: metric.publishedStrategy.configVersion,
  publishedAt: metric.publishedStrategy.publishedAt
    ? metric.publishedStrategy.publishedAt.toISOString()
    : null,
  windowDays: metric.windowDays,
  apy: metric.apy,
  sharpe: metric.sharpe,
  sampleCount: metric.sampleCount,
  trackRecordDays: metric.trackRecordDays,
  computedAt: metric.computedAt.toISOString(),
})

/** The publisher's own view of their listing. */
export const mapPublishedStrategyToResponse = (strategy: any) => ({
  id: strategy.id,
  label: strategy.label,
  strategyConfig: strategy.strategyConfig,
  configVersion: strategy.configVersion,
  isPublished: strategy.isPublished,
  publishedAt: strategy.publishedAt ? strategy.publishedAt.toISOString() : null,
  createdAt: strategy.createdAt ? strategy.createdAt.toISOString() : undefined,
  updatedAt: strategy.updatedAt ? strategy.updatedAt.toISOString() : undefined,
})

/**
 * A follower's own follow. `appliedConfig` is the snapshot their agent runs —
 * surfaced separately from the (possibly newer, possibly delisted, possibly
 * orphaned) live strategy so the follower can see exactly what is in effect.
 */
export const mapFollowToResponse = (follow: any) => ({
  id: follow.id,
  strategyId: follow.publishedStrategyId,
  appliedConfig: follow.appliedConfig,
  appliedConfigVersion: follow.appliedConfigVersion,
  appliedAt: follow.appliedAt.toISOString(),
  followedAt: follow.followedAt.toISOString(),
  strategy: follow.publishedStrategy
    ? {
        id: follow.publishedStrategy.id,
        label: follow.publishedStrategy.label,
        strategyConfig: follow.publishedStrategy.strategyConfig,
        configVersion: follow.publishedStrategy.configVersion,
        isPublished: follow.publishedStrategy.isPublished,
      }
    : null,
})

export const mapGoalToResponse = (goal: any) => ({
  id: goal.id,
  userId: goal.userId,
  positionId: goal.positionId,
  targetAmount: Number(goal.targetAmount),
  startingAmount: Number(goal.startingAmount),
  targetDate: goal.targetDate.toISOString(),
  riskCeiling: goal.riskCeiling,
  status: goal.status,
  createdAt: goal.createdAt.toISOString(),
  updatedAt: goal.updatedAt.toISOString(),
})
