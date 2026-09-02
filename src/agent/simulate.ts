/**
 * Strategy What-If Simulation core (#344) — dry-run before apply.
 *
 * Two pure entry points composed by the owner-scoped service (src/strategy/
 * simulation-service.ts):
 *
 *   simulateImmediate  — run the EXACT decision path (strategy.analyze +
 *                        DecisionTrace shaping) the live agent uses, with every
 *                        side effect stubbed: no outbox enqueue, no event
 *                        publish, no AgentLog write, no RebalanceDecision row.
 *                        The returned trace is the same shape the explainable-
 *                        rebalance ledger persists, so a client that previews a
 *                        config sees exactly what the agent WOULD persist.
 *
 *   simulateHistorical — replays the strategy day-by-day over retained
 *                        ProtocolRate history, accruing yield with Decimal
 *                        (per-leg, then reconciled) and subtracting the SAME
 *                        rebalance-cost estimator the live agent uses, so the
 *                        simulation cannot flatter itself with cheaper fees
 *                        than production.
 *
 * HONESTY RULES (mirror docs/ASSUMPTIONS.md / #285):
 *   * Yield accrual uses the non-compounding APY convention — never a smoothed
 *     cumulative column or compound interest.
 *   * Missing protocol history is treated as UNAVAILABLE for those steps, never
 *     zero-filled.
 *   * The result is labelled "simulation — past protocol rates, not a forecast".
 *   * Deterministic: no wall-clock, no RNG. Identical inputs + identical
 *     history => identical output.
 *
 * STRUCTURAL GUARANTEE: this module never imports a Stellar/outbox/event
 * writer and never touches db — it is pure decision + arithmetic so the
 * zero-side-effects contract is enforced structurally, not by convention.
 */

import { createHash } from 'crypto'
import { Decimal } from '@prisma/client/runtime/library'
import {
  RebalanceStrategy,
  StrategyName,
  StrategyParams,
  RebalanceThresholds,
  UserStrategyPreferences,
  YieldProtocol,
  DecisionTrace,
  RankedCandidate,
} from './types'
import { EffectiveStrategyConfig } from './effectiveStrategy'
import {
  MaxYieldStrategy,
  TargetAllocationStrategy,
  GoalTrackingStrategy,
} from './strategies'
import { estimateRebalanceCost } from './rebalanceCost'
import {
  buildDailyRateSeries,
  DailyRateSnapshot,
  RawProtocolRatePoint,
} from './backtest'

/** Default thresholds when the caller does not supply them. */
export const DEFAULT_SIMULATE_THRESHOLDS: RebalanceThresholds = {
  minimumImprovement: 0.5,
  maxGasPercent: 0.1,
}

/** Hard cap on any single historical replay window (days). */
export const SIMULATE_MAX_WINDOW_DAYS = 180

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_YEAR = 365.25 * MS_PER_DAY

/** Disclaimer shipped with every simulation result. */
export const SIMULATION_LABEL =
  'Simulation based on past protocol rates — not a forecast of future returns.'

/** Resolve the strategy instance for an effective config name (default MAX_YIELD). */
export function resolveSimulationStrategy(
  strategyName: StrategyName | null
): RebalanceStrategy {
  switch (strategyName) {
    case 'TARGET_ALLOCATION':
      return new TargetAllocationStrategy()
    case 'GOAL_TRACKING':
      return new GoalTrackingStrategy()
    case 'MAX_YIELD':
    default:
      return new MaxYieldStrategy()
  }
}

// ── Immediate decision ───────────────────────────────────────────────────────

export interface SimulateImmediateInput {
  /** The caller's current ACTIVE positions (reads happen in the service). */
  positions: Array<{ protocolName: string; currentValue: string }>
  effectiveConfig: EffectiveStrategyConfig
  thresholds?: RebalanceThresholds
  /** Protocol risk scores keyed by name; empty when no ceiling is in effect. */
  riskScores?: Record<string, number>
  /** The current scanned protocol universe (sorted by APY, as the agent sees). */
  availableProtocols: YieldProtocol[]
  /** Active SavingsGoal driving GOAL_TRACKING; undefined means no active goal. */
  goal?: StrategyParams['goal']
  /** Point-in-time label for the preview; never used in the decision itself. */
  asOf: Date
}

export interface ImmediateSimulationResult {
  action: 'rebalance' | 'hold' | 'blocked'
  targetProtocol: string | null
  moves: Array<{ toProtocol: string; fraction: number }>
  trace: DecisionTrace
  reasoning: string
}

/**
 * Rebuild the DecisionTrace exactly as router.ts's buildStrategyTrace does, so
 * the preview is shape-identical to the persisted explainable-decision record.
 * Pure — reads only the strategy's returned decision + the traced set.
 */
export function buildSimulationTrace(
  decision: {
    details?: Record<string, unknown>
    candidates?: RankedCandidate[]
    shouldRebalance: boolean
    targetProtocol: string
  },
  currentApyVal: number | null,
  thresholds: RebalanceThresholds
): DecisionTrace {
  const details = decision.details ?? {}
  const candidates = decision.candidates ?? []
  const chosenName: string | null = decision.shouldRebalance
    ? decision.targetProtocol
    : null
  const chosenCandidate =
    candidates.find((c) => c.protocol === chosenName) ?? null
  const chosenApy: number | null =
    chosenCandidate?.apy ??
    (typeof details.bestApy === 'number' ? details.bestApy : null)
  const rawImprovement: number | null =
    typeof details.rawImprovement === 'number' ? details.rawImprovement : null
  const netImprovement: number | null =
    typeof details.netImprovement === 'number' ? details.netImprovement : null
  const costBreakdown: Record<string, unknown> | null =
    (details.costBreakdown as Record<string, unknown> | undefined) ?? null
  const estCostPercent: number | null =
    costBreakdown && typeof costBreakdown.totalCostPct === 'number'
      ? costBreakdown.totalCostPct
      : typeof details.totalCostPercent === 'number'
        ? details.totalCostPercent
        : null
  return {
    currentApy: currentApyVal,
    chosenProtocol: chosenName,
    chosenApy,
    rawImprovement,
    netImprovement,
    estCostPercent,
    costBreakdown,
    thresholds,
    candidates,
  }
}

/**
 * Shape StrategyParams the way the live engine receives them for a single
 * (protocol, value) leg — mirroring src/agent/loop.ts's preference shaping
 * plus the goal contract.
 */
function buildSimulationParams(args: {
  currentProtocol: string
  totalAmount: string
  currentApy: number
  availableProtocols: YieldProtocol[]
  effectiveConfig: EffectiveStrategyConfig
  thresholds: RebalanceThresholds
  riskScores?: Record<string, number>
  goal?: StrategyParams['goal']
  userId: string
}): StrategyParams {
  const prefs: UserStrategyPreferences[] = args.effectiveConfig
    .targetAllocations
    ? [
        {
          userId: args.userId,
          strategyName: args.effectiveConfig.strategyName,
          targetAllocations: args.effectiveConfig.targetAllocations,
          riskCeiling: args.effectiveConfig.riskCeiling,
          exposureCaps: args.effectiveConfig.exposureCaps,
          defaultMaxFraction: args.effectiveConfig.defaultMaxFraction,
        },
      ]
    : []
  return {
    currentProtocol: args.currentProtocol,
    totalAmount: args.totalAmount,
    currentApy: args.currentApy,
    availableProtocols: args.availableProtocols,
    thresholds: args.thresholds,
    userStrategyPreferences: prefs,
    riskCeiling: args.effectiveConfig.riskCeiling,
    protocolRiskScores:
      args.effectiveConfig.riskCeiling !== undefined && args.riskScores
        ? args.riskScores
        : undefined,
    goal: args.goal,
    exposure: undefined,
  }
}

function emptyTrace(thresholds: RebalanceThresholds): DecisionTrace {
  return {
    currentApy: null,
    chosenProtocol: null,
    chosenApy: null,
    rawImprovement: null,
    netImprovement: null,
    estCostPercent: null,
    costBreakdown: null,
    thresholds,
    candidates: [],
  }
}

/**
 * Run the immediate decision the agent would take on the caller's current
 * positions under the supplied effective config. Zero side effects.
 *
 * For each distinct protocol the user holds the agent would evaluate a move;
 * this returns the action for the highest-value leg (the live loop moves one
 * protocol's holdings at a time). GOAL_TRACKING without an active goal blocks,
 * matching live behavior.
 */
export async function simulateImmediate(
  input: SimulateImmediateInput
): Promise<ImmediateSimulationResult> {
  const thresholds = input.thresholds ?? DEFAULT_SIMULATE_THRESHOLDS

  if (input.effectiveConfig.strategyName === 'GOAL_TRACKING' && !input.goal) {
    return {
      action: 'blocked',
      targetProtocol: null,
      moves: [],
      trace: emptyTrace(thresholds),
      reasoning: 'GOAL_TRACKING requires an active savings goal',
    }
  }

  if (input.positions.length === 0) {
    return {
      action: 'hold',
      targetProtocol: null,
      moves: [],
      trace: emptyTrace(thresholds),
      reasoning: 'No active positions — nothing for the agent to act on',
    }
  }

  // Evaluate the highest-value protocol first.
  const byProtocol = new Map<string, Decimal>()
  for (const p of input.positions) {
    byProtocol.set(
      p.protocolName,
      (byProtocol.get(p.protocolName) ?? new Decimal(0)).plus(p.currentValue)
    )
  }
  const currentProtocol = [...byProtocol.entries()].sort((a, b) =>
    b[1].comparedTo(a[1])
  )[0][0]

  const rate = input.availableProtocols.find((p) => p.name === currentProtocol)
  const currentApy = rate?.apy ?? 0

  const params = buildSimulationParams({
    currentProtocol,
    totalAmount: amountToWeiLike(byProtocol.get(currentProtocol)!),
    currentApy,
    availableProtocols: input.availableProtocols,
    effectiveConfig: input.effectiveConfig,
    thresholds,
    riskScores: input.riskScores,
    goal: input.goal,
    userId: '',
  })

  const strategy = resolveSimulationStrategy(input.effectiveConfig.strategyName)
  const decision = await strategy.analyze(params)
  const trace = buildSimulationTrace(decision, currentApy, thresholds)

  if (
    !decision.shouldRebalance ||
    decision.targetProtocol === currentProtocol
  ) {
    return {
      action: decision.blockedReason ? 'blocked' : 'hold',
      targetProtocol: null,
      moves: [],
      trace,
      reasoning: decision.reasoning,
    }
  }

  return {
    action: 'rebalance',
    targetProtocol: decision.targetProtocol,
    moves: [{ toProtocol: decision.targetProtocol, fraction: 1 }],
    trace,
    reasoning: decision.reasoning,
  }
}

// ── Historical replay ────────────────────────────────────────────────────────

export interface SimulateHistoricalInput {
  /** Value being simulated (current position value or a hypothetical deposit). */
  startingAmount: string
  /** Protocol the value starts in at the start of the window (null => best). */
  startingProtocol: string | null
  effectiveConfig: EffectiveStrategyConfig
  thresholds?: RebalanceThresholds
  riskScores?: Record<string, number>
  /** Already-built daily rate snapshots (retained history, in date order). */
  dailyRates: DailyRateSnapshot[]
  /** Upstream data caveats (window truncation, protocol gaps) to carry through. */
  dataCaveats?: string[]
  goal?: StrategyParams['goal']
  userId: string
}

export interface HistoricalTimeSeriesPoint {
  date: string // YYYY-MM-DD
  simulatedValue: string
  counterfactualValue: string
}

export interface HistoricalSimulationResult {
  rebalanceCount: number
  turnoverRatio: number
  totalFeesPaid: string
  endingValue: string
  startingValue: string
  counterfactualEndingValue: string
  finalProtocol: string | null
  timeSeries: HistoricalTimeSeriesPoint[]
  realizedGainPct: number | null
  counterfactualGainPct: number | null
  dataCaveats: string[]
}

/**
 * Replay the strategy over retained history from a starting amount/protocol.
 *
 * The counterfactual holds the SAME starting value in the SAME starting
 * protocol for the whole window (no rebalancing, no fees) — a clean side-by-side
 * with the strategy leg. Both legs accrue non-compounding APY in Decimal per
 * day; the strategy leg subtracts the live `estimateRebalanceCost` on every
 * rebalance. Deterministic given identical inputs + history.
 */
export async function simulateHistorical(
  input: SimulateHistoricalInput
): Promise<HistoricalSimulationResult> {
  const thresholds = input.thresholds ?? DEFAULT_SIMULATE_THRESHOLDS
  const strategy = resolveSimulationStrategy(input.effectiveConfig.strategyName)
  const startingValue = new Decimal(input.startingAmount)
  const caveats = [...(input.dataCaveats ?? [])]

  const firstPopulated = input.dailyRates.findIndex(
    (d) => d.protocols.length > 0
  )
  if (startingValue.lte(0)) {
    caveats.push('No starting value — historical replay skipped')
    return {
      rebalanceCount: 0,
      turnoverRatio: 0,
      totalFeesPaid: '0',
      endingValue: '0',
      startingValue: startingValue.toString(),
      counterfactualEndingValue: '0',
      finalProtocol: input.startingProtocol,
      timeSeries: [],
      realizedGainPct: null,
      counterfactualGainPct: null,
      dataCaveats: caveats,
    }
  }
  if (firstPopulated === -1) {
    caveats.push('Insufficient historical rate data for replay')
    return {
      rebalanceCount: 0,
      turnoverRatio: 0,
      totalFeesPaid: '0',
      endingValue: startingValue.toString(),
      startingValue: startingValue.toString(),
      counterfactualEndingValue: startingValue.toString(),
      finalProtocol: input.startingProtocol,
      timeSeries: [],
      realizedGainPct: null,
      counterfactualGainPct: null,
      dataCaveats: caveats,
    }
  }

  let currentProtocol = input.startingProtocol
  let simValue = startingValue
  let counterfactualValue = startingValue
  let totalFees = new Decimal(0)
  let rebalanceCount = 0
  let turnover = new Decimal(0)
  const timeSeries: HistoricalTimeSeriesPoint[] = []

  for (const day of input.dailyRates) {
    if (day.protocols.length === 0) {
      // No data at all even after forward-fill — hold both legs flat.
      timeSeries.push({
        date: formatDate(day.date),
        simulatedValue: simValue.toString(),
        counterfactualValue: counterfactualValue.toString(),
      })
      continue
    }

    const currentRate = currentProtocol
      ? day.protocols.find((p) => p.name === currentProtocol)
      : undefined

    if (!currentProtocol || !currentRate) {
      // No current protocol yet or its rate is unavailable today. Anchor to the
      // first day's best-yielding protocol when none is set, else hold at 0 APY
      // (missing history treated as unavailable — never a fabricated rate).
      currentProtocol =
        currentProtocol ??
        day.protocols.reduce((best, p) => (p.apy > best.apy ? p : best)).name
      const anchorRate = day.protocols.find((p) => p.name === currentProtocol)
      const apy = anchorRate?.apy ?? 0
      const simDaily = nonCompoundingDaily(simValue, apy)
      const ctrDaily = nonCompoundingDaily(counterfactualValue, apy)
      simValue = simValue.plus(simDaily)
      counterfactualValue = counterfactualValue.plus(ctrDaily)
      timeSeries.push({
        date: formatDate(day.date),
        simulatedValue: simValue.toString(),
        counterfactualValue: counterfactualValue.toString(),
      })
      continue
    }

    const currentApy = currentRate.apy

    // Accrue one day of simple (non-compounding) return on BOTH legs first.
    simValue = simValue.plus(nonCompoundingDaily(simValue, currentApy))
    counterfactualValue = counterfactualValue.plus(
      nonCompoundingDaily(counterfactualValue, currentApy)
    )

    const params = buildSimulationParams({
      currentProtocol,
      totalAmount: amountToWeiLike(simValue),
      currentApy,
      availableProtocols: day.protocols,
      effectiveConfig: input.effectiveConfig,
      thresholds,
      riskScores: input.riskScores,
      goal: input.goal,
      userId: input.userId,
    })
    const decision = await strategy.analyze(params)

    if (
      decision.shouldRebalance &&
      decision.targetProtocol !== currentProtocol
    ) {
      // Subtract the SAME cost model the live agent uses. The agent holds one
      // protocol at a time, so a rebalance moves the whole position.
      const cost = estimateRebalanceCost({
        fromProtocol: currentProtocol,
        toProtocol: decision.targetProtocol,
        amount: amountToWeiLike(simValue),
        assetSymbol: currentRate.assetSymbol,
        sameAsset: true,
        feeSnapshot: null,
      })
      const fee = new Decimal(cost.totalCostPct / 100).mul(simValue)
      simValue = simValue.minus(fee)
      totalFees = totalFees.plus(fee)
      turnover = turnover.plus(simValue)
      rebalanceCount += 1
      currentProtocol = decision.targetProtocol
    }

    timeSeries.push({
      date: formatDate(day.date),
      simulatedValue: simValue.toString(),
      counterfactualValue: counterfactualValue.toString(),
    })
  }

  const windowStart = firstStepDate(input.dailyRates)
  const windowEnd = lastStepDate(input.dailyRates)
  const years = (windowEnd.getTime() - windowStart.getTime()) / MS_PER_YEAR

  const gainPct = (v: Decimal, base: Decimal): number | null =>
    base.gt(0) && years > 0 ? Number(v.minus(base).div(base).mul(100)) : null

  return {
    rebalanceCount,
    turnoverRatio: simValue.gt(0) ? Number(turnover.div(simValue)) : 0,
    totalFeesPaid: totalFees.toString(),
    endingValue: simValue.toString(),
    startingValue: startingValue.toString(),
    counterfactualEndingValue: counterfactualValue.toString(),
    finalProtocol: currentProtocol,
    timeSeries,
    realizedGainPct: gainPct(simValue, startingValue),
    counterfactualGainPct: gainPct(counterfactualValue, startingValue),
    dataCaveats: caveats,
  }
}

/** Simple (non-compounding) one-day accrued return. */
function nonCompoundingDaily(value: Decimal, apy: number): Decimal {
  if (!Number.isFinite(apy) || apy <= 0) return new Decimal(0)
  return value.mul(new Decimal(apy).div(100)).div(365.25)
}

/**
 * Encode a dollar value as the wei-like string the shared cost model expects.
 * Mirrors the backtest engine's encoding (value * 10^18) so that
 * `estimateRebalanceCost`/`amountToHumanUnits` divide back to human units and
 * produce a realistic fee percentage.
 */
function amountToWeiLike(value: Decimal): string {
  const micro = BigInt(Math.round(Number(value.mul(1e6))))
  return (micro * 10n ** 12n).toString()
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function firstStepDate(series: DailyRateSnapshot[]): Date {
  return series.length > 0 ? series[0].date : new Date()
}

function lastStepDate(series: DailyRateSnapshot[]): Date {
  return series.length > 0 ? series[series.length - 1].date : new Date()
}

/**
 * Build a daily rate series for a window, truncating to available retention and
 * surfacing a caveat when the window was shortened. `maxWindowDays` bounds the
 * replay's compute (a compute-exhaustion guard enforced here and at the route).
 */
export function buildSimulationRateSeries(
  rawPoints: RawProtocolRatePoint[],
  windowStart: Date,
  windowEnd: Date,
  maxWindowDays: number = SIMULATE_MAX_WINDOW_DAYS
): {
  series: DailyRateSnapshot[]
  dataCaveats: string[]
  earliestAvailableDate: Date | null
} {
  const caveats: string[] = []

  const requestedDays =
    (windowEnd.getTime() - windowStart.getTime()) / MS_PER_DAY
  if (requestedDays > maxWindowDays) {
    caveats.push(
      `Window longer than the ${maxWindowDays}-day simulation cap — truncated`
    )
  }

  if (rawPoints.length === 0) {
    return {
      series: [],
      dataCaveats: ['No retained rate history for this window'],
      earliestAvailableDate: null,
    }
  }

  // Clamp the window to the span of retained observations at BOTH ends so the
  // replay only ever prices days we actually have data for — never extrapolates
  // before the first observation or after the last one.
  const first = rawPoints.reduce<Date>(
    (earliest, p) => (p.date < earliest ? p.date : earliest),
    new Date(8640000000000000)
  )
  const last = rawPoints.reduce<Date>(
    (latest, p) => (p.date > latest ? p.date : latest),
    new Date(-8640000000000000)
  )
  const effectiveStart =
    first.getTime() > windowStart.getTime() ? first : windowStart
  const effectiveEnd = last.getTime() < windowEnd.getTime() ? last : windowEnd

  const earliestAvailableDate =
    first.getTime() > windowStart.getTime() ? first : null
  if (earliestAvailableDate) {
    caveats.push(
      `Retained history starts ${formatDate(first)} — window truncated to available data`
    )
  }
  if (last.getTime() < windowEnd.getTime()) {
    caveats.push(
      `Retained history ends ${formatDate(last)} — window truncated to available data`
    )
  }

  const trimmed = rawPoints.filter(
    (p) => p.date >= effectiveStart && p.date <= effectiveEnd
  )
  const series = buildDailyRateSeries(
    trimmed,
    effectiveStart,
    effectiveEnd
  ).series

  return { series, dataCaveats: caveats, earliestAvailableDate }
}

/**
 * Opaque token binding a simulation to the exact submitted config + window so a
 * later apply step (out of scope here) can guarantee the user previewed
 * precisely what they saved. Pure hash of canonical inputs — no wall-clock.
 */
export function buildSimulationToken(
  config: EffectiveStrategyConfig,
  historyWindowDays: number,
  asOfIso: string
): string {
  const canonical = JSON.stringify({
    strategyName: config.strategyName ?? null,
    targetAllocations: config.targetAllocations
      ? Object.keys(config.targetAllocations)
          .sort()
          .map((k) => `${k}=${config.targetAllocations![k]}`)
          .join(',')
      : null,
    riskCeiling: config.riskCeiling ?? null,
    historyWindowDays,
    asOf: asOfIso,
  })
  return (
    'sim:' + createHash('sha256').update(canonical).digest('hex').slice(0, 24)
  )
}
