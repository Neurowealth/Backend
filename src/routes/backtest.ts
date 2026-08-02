/**
 * Backtest Engine — pure historical replay for RebalanceStrategy implementations.
 *
 * STRUCTURAL GUARANTEE (see tests/unit/agent/backtest.test.ts):
 * This file must never import anything from `src/stellar/*`, and must never
 * import Position/Transaction/CustodialWallet. A backtest simulates a
 * strategy's decisions against historical rate data — it never touches real
 * funds or submits a real transaction. That guarantee is enforced by a test
 * asserting zero `src/stellar` imports in this file's source text, not just
 * by convention.
 */

import {
  RebalanceStrategy,
  StrategyName,
  StrategyParams,
  RebalanceThresholds,
  UserStrategyPreferences,
  YieldProtocol,
} from '../agent/types'

/** Default thresholds applied when a backtest request doesn't specify them. */
export const DEFAULT_BACKTEST_THRESHOLDS: RebalanceThresholds = {
  minimumImprovement: 0.5,
  maxGasPercent: 0.1,
}

/**
 * One day's worth of protocol APY data, AFTER gap-handling has already been
 * applied (see buildDailyRateSeries). Every protocol in `protocols` has a
 * value for this date — either a real observation or a forward-filled one.
 */
export interface DailyRateSnapshot {
  date: Date
  protocols: YieldProtocol[]
}

/**
 * A single raw historical observation as read from ProtocolRate. May have
 * gaps — a protocol can be missing entirely on days it had no observation.
 */
export interface RawProtocolRatePoint {
  protocolName: string
  assetSymbol: string
  apy: number
  date: Date
}

export interface BacktestRequest {
  strategyName: StrategyName
  startDate: Date
  endDate: Date
  startingAmount: number
  thresholds?: RebalanceThresholds
  userStrategyPreferences?: UserStrategyPreferences[]
  riskCeiling?: number
  protocolRiskScores?: Record<string, number>
  goal?: StrategyParams['goal']
}

export interface BacktestSummary {
  finalValue: number
  maxDrawdownPercent: number
  /**
   * Simple (non-compounding) annualized realized rate, using the identical
   * convention as calculateApy in src/agent/snapshotter.ts:
   *   (gain / startingAmount / years) * 100
   * Intentional — a backtest's "realized APY" must mean the same thing to a
   * user as a live position's "realized APY".
   */
  realizedApy: number
}

export interface BacktestTimeSeriesPoint {
  date: string // YYYY-MM-DD
  simulatedValue: number
}

export interface BacktestResult {
  timeSeries: BacktestTimeSeriesPoint[]
  summary: BacktestSummary
  finalProtocol: string
  /** Every rebalance the strategy made during the run, in chronological order. */
  rebalanceEvents: {
    date: string
    fromProtocol: string
    toProtocol: string
    reasoning: string
  }[]
}

export type BacktestOutcome =
  | { status: 'ok'; result: BacktestResult }
  | { status: 'insufficient_history'; earliestAvailableDate: Date | null }
  | { status: 'invalid_range'; reason: string }

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_YEAR = 365.25 * MS_PER_DAY

/**
 * Gap-handling policy: HOLD PREVIOUS VALUE (forward-fill).
 *
 * When a protocol has no rate observation for a given day (rate collection
 * gap, or the protocol simply didn't exist yet), we carry forward its most
 * recent known APY rather than dropping it from the universe or zero-filling.
 * A protocol with zero observations up to and including a given day is
 * excluded from that day's snapshot entirely (there is nothing to hold
 * forward) — it becomes eligible starting the day of its first observation.
 *
 * Rationale: excluding a protocol on a rate-collection gap would make a
 * strategy's candidate universe flicker day-to-day for reasons unrelated to
 * the protocol's real availability, silently skewing which protocol looks
 * "best" purely due to collection artifacts. Holding the last known rate is
 * a conservative, explicit, documented choice — not a silent default.
 */
export function buildDailyRateSeries(
  rawPoints: RawProtocolRatePoint[],
  startDate: Date,
  endDate: Date
): { series: DailyRateSnapshot[]; earliestAvailableDate: Date | null } {
  if (rawPoints.length === 0) {
    return { series: [], earliestAvailableDate: null }
  }

  const earliestAvailableDate = rawPoints.reduce(
    (earliest, p) => (p.date < earliest ? p.date : earliest),
    rawPoints[0].date
  )

  const byProtocol = new Map<string, RawProtocolRatePoint[]>()
  for (const point of rawPoints) {
    const list = byProtocol.get(point.protocolName) ?? []
    list.push(point)
    byProtocol.set(point.protocolName, list)
  }
  for (const list of byProtocol.values()) {
    list.sort((a, b) => a.date.getTime() - b.date.getTime())
  }

  const series: DailyRateSnapshot[] = []
  const pointerIndex = new Map<string, number>()
  const heldValue = new Map<string, RawProtocolRatePoint>()
  for (const p of byProtocol.keys()) pointerIndex.set(p, 0)

  const dayCount =
    Math.floor((endDate.getTime() - startDate.getTime()) / MS_PER_DAY) + 1

  for (let i = 0; i < dayCount; i++) {
    const day = new Date(startDate.getTime() + i * MS_PER_DAY)
    const protocolsToday: YieldProtocol[] = []

    for (const [protocolName, points] of byProtocol.entries()) {
      let idx = pointerIndex.get(protocolName) ?? 0
      while (
        idx < points.length &&
        points[idx].date.getTime() <= day.getTime()
      ) {
        heldValue.set(protocolName, points[idx])
        idx++
      }
      pointerIndex.set(protocolName, idx)

      const held = heldValue.get(protocolName)
      if (held) {
        protocolsToday.push({
          name: held.protocolName,
          apy: held.apy,
          assetSymbol: held.assetSymbol,
          lastUpdated: held.date,
          isAvailable: true,
        })
      }
      // No held value yet (protocol's first observation is still in the
      // future relative to `day`) — correctly excluded from today's universe.
    }

    series.push({ date: day, protocols: protocolsToday })
  }

  return { series, earliestAvailableDate }
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function calculateMaxDrawdownPercent(values: number[]): number {
  let peak = values.length > 0 ? values[0] : 0
  let maxDrawdown = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      const drawdown = ((peak - v) / peak) * 100
      if (drawdown > maxDrawdown) maxDrawdown = drawdown
    }
  }
  return maxDrawdown
}

/**
 * Same simple-rate convention as calculateApy in snapshotter.ts:
 * (gain / principal / years) * 100. Mirrors that function's guard.
 */
function calculateRealizedApy(
  startingAmount: number,
  finalValue: number,
  years: number
): number {
  if (startingAmount <= 0 || years <= 0) return 0
  return ((finalValue - startingAmount) / startingAmount / years) * 100
}

/**
 * Runs a historical replay of `strategy` against `dailyRates`.
 *
 * The starting protocol is the highest-APY protocol available on the first
 * day of the window — a backtest has no prior live position to anchor to, so
 * this is the most neutral starting assumption. (If product wants to
 * backtest starting from a *specific* protocol, extend BacktestRequest with
 * an optional `startingProtocol` and use it here instead.)
 */
export async function runBacktest(
  strategy: RebalanceStrategy,
  dailyRates: DailyRateSnapshot[],
  request: BacktestRequest
): Promise<BacktestOutcome> {
  if (request.startingAmount <= 0) {
    return {
      status: 'invalid_range',
      reason: 'startingAmount must be positive',
    }
  }
  if (request.endDate.getTime() <= request.startDate.getTime()) {
    return {
      status: 'invalid_range',
      reason: 'endDate must be after startDate',
    }
  }
  if (dailyRates.length === 0) {
    return { status: 'insufficient_history', earliestAvailableDate: null }
  }

  const first = dailyRates[0]
  if (first.protocols.length === 0) {
    return { status: 'insufficient_history', earliestAvailableDate: null }
  }

  let currentValue = request.startingAmount
  let currentProtocol = first.protocols.reduce((best, p) =>
    p.apy > best.apy ? p : best
  ).name

  const timeSeries: BacktestTimeSeriesPoint[] = []
  const rebalanceEvents: BacktestResult['rebalanceEvents'] = []
  const values: number[] = []

  for (const day of dailyRates) {
    if (day.protocols.length === 0) {
      // No data at all for this day even after forward-fill (can happen at
      // the very start of the window, before any protocol's first
      // observation). Hold value flat rather than fabricating growth.
      timeSeries.push({
        date: formatDate(day.date),
        simulatedValue: currentValue,
      })
      values.push(currentValue)
      continue
    }

    const currentProtocolRate = day.protocols.find(
      (p) => p.name === currentProtocol
    )
    const currentApy = currentProtocolRate?.apy ?? 0

    // Accrue one day of simple (non-compounding) return at currentApy before
    // asking the strategy whether to rebalance.
    const dailyReturn = (currentApy / 100 / 365.25) * currentValue
    currentValue += dailyReturn

    const params: StrategyParams = {
      currentProtocol,
      totalAmount: (currentValue * 1e18).toString(),
      currentApy,
      availableProtocols: day.protocols,
      thresholds: request.thresholds ?? DEFAULT_BACKTEST_THRESHOLDS,
      userStrategyPreferences: request.userStrategyPreferences ?? [],
      riskCeiling: request.riskCeiling,
      protocolRiskScores: request.protocolRiskScores,
      goal: request.goal,
    }

    const decision = await strategy.analyze(params)

    if (
      decision.shouldRebalance &&
      decision.targetProtocol !== currentProtocol
    ) {
      rebalanceEvents.push({
        date: formatDate(day.date),
        fromProtocol: currentProtocol,
        toProtocol: decision.targetProtocol,
        reasoning: decision.reasoning,
      })
      currentProtocol = decision.targetProtocol
    }

    timeSeries.push({
      date: formatDate(day.date),
      simulatedValue: currentValue,
    })
    values.push(currentValue)
  }

  const years =
    (request.endDate.getTime() - request.startDate.getTime()) / MS_PER_YEAR

  const summary: BacktestSummary = {
    finalValue: currentValue,
    maxDrawdownPercent: calculateMaxDrawdownPercent(values),
    realizedApy: calculateRealizedApy(
      request.startingAmount,
      currentValue,
      years
    ),
  }

  return {
    status: 'ok',
    result: {
      timeSeries,
      summary,
      finalProtocol: currentProtocol,
      rebalanceEvents,
    },
  }
}
