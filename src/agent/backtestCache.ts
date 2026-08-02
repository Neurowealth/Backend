/**
 * Result cache for POST /api/agent/backtest.
 *
 * Historical ProtocolRate/YieldSnapshot rows are immutable once written, so
 * an identical (strategy, startDate, endDate, startingAmount) request always
 * produces the identical result — safe to serve from cache without
 * recomputing the replay.
 */
import { BacktestOutcome, BacktestRequest } from './backtest'

const cache = new Map<string, BacktestOutcome>()

export function buildCacheKey(
  request: Pick<
    BacktestRequest,
    'strategyName' | 'startDate' | 'endDate' | 'startingAmount'
  >
): string {
  return [
    request.strategyName,
    request.startDate.toISOString(),
    request.endDate.toISOString(),
    request.startingAmount,
  ].join('|')
}

export function getCached(key: string): BacktestOutcome | undefined {
  return cache.get(key)
}

export function setCached(key: string, outcome: BacktestOutcome): void {
  cache.set(key, outcome)
}

/** Exposed for tests only — clears the in-memory cache between test cases. */
export function clearBacktestCache(): void {
  cache.clear()
}
