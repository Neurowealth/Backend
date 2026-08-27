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
  // Benchmark-relative figure (#320): portfolioReturn - benchmarkReturn over the
  // window, from StrategyAttribution. Null when attribution has not been
  // computed for this strategy/window yet — never fabricated. Merged onto the
  // metric row by src/strategy/service.ts's getMarketplace before this mapper
  // runs; still only ever a relative figure, never an absolute balance.
  vsBenchmark: metric.vsBenchmark ?? null,
})

/**
 * One sector row of a performance-attribution breakdown (#320). Shared by both
 * the owner-scoped portfolio endpoint and the marketplace's vsBenchmark path.
 */
const mapSectorAttribution = (sector: any) => ({
  sector: sector.sector,
  portfolioWeight: sector.portfolioWeight,
  benchmarkWeight: sector.benchmarkWeight,
  portfolioReturn: sector.portfolioReturn,
  benchmarkReturn: sector.benchmarkReturn,
  allocationEffect: sector.allocationEffect,
  selectionEffect: sector.selectionEffect,
})

/**
 * A precomputed PortfolioAttribution/StrategyAttribution row (#320). Never
 * carries userId — the caller already knows whose row this is (owner-scoped
 * request, or the publisher's own aggregates for a strategy).
 */
export const mapPortfolioAttributionToResponse = (row: any) => ({
  windowDays: row.windowDays,
  portfolioReturn: row.portfolioReturn,
  benchmarkReturn: row.benchmarkReturn,
  vsBenchmark: row.portfolioReturn - row.benchmarkReturn,
  allocationEffect: row.allocationEffect,
  selectionEffect: row.selectionEffect,
  unattributedEffect: row.unattributedEffect,
  reconciliationGap: row.reconciliationGap,
  reconciled: row.reconciled,
  benchmarkVersion: row.benchmarkVersion,
  sectors: (row.sectorBreakdown as any[]).map(mapSectorAttribution),
  computedAt: row.computedAt.toISOString(),
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

/**
 * Portfolio-optimization suggestion (#322), for the stored-history endpoint.
 *
 * Hand-written allowlist, deliberately never a spread — same discipline as the
 * marketplace mappers above. `userId` is intentionally omitted: the caller is
 * already scoped to their own rows by enforceUserAccess, so echoing it back adds
 * nothing and makes it that much easier for a future refactor to leak the column
 * into a listing that is not owner-scoped.
 *
 * `isSuggestion` is emitted on EVERY row. A stored allocation and an applied
 * one look identical on the wire otherwise, and this feature's whole safety
 * story is that they are not the same thing.
 */
export const mapAllocationSuggestionToResponse = (suggestion: any) => ({
  id: suggestion.id,
  isSuggestion: true as const,
  status: suggestion.status,
  inputHash: suggestion.inputHash,
  weights: suggestion.weights,
  frontier: suggestion.frontier,
  backtest: suggestion.backtestSummary ?? null,
  riskTolerance: suggestion.riskTolerance,
  effectiveRiskCeiling: suggestion.effectiveRiskCeiling ?? null,
  reason: suggestion.reason ?? null,
  computedAt: suggestion.computedAt.toISOString(),
})

/**
 * Real-time stream payload allowlists (#316) — the socket's equivalent of the
 * REST mappers above, and held to the same rule.
 *
 * A WebSocket frame is a response body. It gets the same discipline: a
 * hand-written allowlist per event type, never a spread, never a denylist. The
 * emit sites pass the same object they hand `dispatchWebhookEvent`, and those
 * objects carry `userId` (an operator's webhook endpoint is a trusted server;
 * an end user's browser is not). Anything not named here is dropped before the
 * payload is persisted to `user_events`, so a replay cannot leak what the live
 * path stripped.
 *
 * Adding a key here is the moment to ask: would I put this in a REST response
 * for this user? If not, it does not belong on their socket either.
 */
const USER_EVENT_PAYLOAD_ALLOWLIST: Record<string, readonly string[]> = {
  'transaction.confirmed': [
    'txHash',
    'type',
    'status',
    'assetSymbol',
    'amount',
    'protocolName',
  ],
  // `user` (the wallet address) is deliberately absent: the client already
  // knows its own wallet, and a delegated parent connection must not learn the
  // child's address from a stream frame.
  'deposit.received': [
    'txHash',
    'amount',
    'shares',
    'assetSymbol',
    'protocolName',
    'network',
  ],
  'withdraw.completed': [
    'txHash',
    'amount',
    'shares',
    'assetSymbol',
    'protocolName',
    'network',
  ],
  'agent.rebalanced': [
    'txHash',
    'fromProtocol',
    'toProtocol',
    'amount',
    'improvedBy',
    'timestamp',
  ],
  'fiat.order.settled': [
    'orderId',
    'provider',
    'direction',
    'status',
    'txHash',
  ],
  'fiat.order.failed': [
    'orderId',
    'provider',
    'direction',
    'status',
    'failureReason',
  ],
  'fiat.order.rate_mismatch': [
    'orderId',
    'provider',
    'direction',
    'quotedCryptoAmount',
    'settledCryptoAmount',
    'driftPct',
  ],
  'recurring_deposit.executed': [
    'planId',
    'amount',
    'assetSymbol',
    'cadence',
    'txHash',
  ],
  'recurring_deposit.failed': [
    'planId',
    'amount',
    'assetSymbol',
    'cadence',
    'reason',
  ],
  'alert_rule.triggered': [
    'ruleId',
    'metric',
    'protocolName',
    'comparator',
    'threshold',
    'observedValue',
    'triggeredAt',
  ],
  // `followerUserId` is dropped: the frame is already scoped to that follower.
  'strategy.updated': ['strategyId', 'label', 'configVersion'],
  'strategy.unpublished': ['strategyId', 'label'],
  // `error` is the user's own op failure text, already sent to their webhooks.
  'outbox.op_failed': ['opId', 'kind', 'attempts', 'error'],
  'portfolio.updated': ['protocolName', 'positionsAffected', 'reason'],
}

/**
 * Project a domain payload onto the allowlist for its event type.
 *
 * An unknown event type yields `{}` rather than the original object: a type
 * nobody has reviewed is a type whose fields nobody has reviewed. Values are
 * copied as-is (they are already JSON-safe primitives at every emit site);
 * `undefined` values are omitted so the stored JSON stays clean.
 */
export const mapUserEventPayloadToResponse = (
  eventType: string,
  payload: Record<string, unknown>
): Record<string, unknown> => {
  const allowed = USER_EVENT_PAYLOAD_ALLOWLIST[eventType]
  if (!allowed) return {}

  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    if (payload[key] !== undefined) out[key] = payload[key]
  }
  return out
}
