/**
 * Strategy What-If Simulation service (#344) — the owner-scoped DB glue around
 * the pure core in src/agent/simulate.ts.
 *
 * Resolves the caller's own config + active follow + active goal, validates the
 * submitted hypothetical config, loads the caller's positions and public
 * ProtocolRate history, then composes simulateImmediate + simulateHistorical.
 *
 * ZERO SIDE EFFECTS is the contract this service is responsible for: it never
 * writes an OutboxOp, AgentLog, Transaction, event, or User/PublishedStrategy
 * row. The acceptance test asserts no such row is created by a call.
 *
 * Owner-scoped: reads only the caller's Position rows and public
 * ProtocolRate/ProtocolRiskScore data.
 */

import db from '../db'
import { logger } from '../utils/logger'
import {
  parseStrategyConfig,
  resolveEffectiveConfig,
  EffectiveStrategyConfig,
  StrategyConfigShape,
} from '../agent/effectiveStrategy'
import {
  simulateImmediate,
  simulateHistorical,
  buildSimulationRateSeries,
  buildSimulationToken,
  SIMULATE_MAX_WINDOW_DAYS,
  SIMULATION_LABEL,
  ImmediateSimulationResult,
  HistoricalSimulationResult,
} from '../agent/simulate'
import { scanAllProtocols } from '../agent/scanner'
import { getThresholds } from '../agent/router'
import { StrategyName, StrategyParams } from '../agent/types'
import { cacheGet, cacheSet } from '../config/redis'

const SIMULATION_CACHE_TTL = 120 // 2 minutes

export class SimulationValidationError extends Error {}
export class SimulationNotFoundError extends Error {}

export interface SimulateStrategyRequest {
  strategy?: StrategyName | null
  targetAllocations?: Record<string, number>
  riskCeiling?: number
  followStrategyId?: string | null
  historyWindowDays?: number
  assumeInitialDeposit?: boolean
}

export interface SimulateStrategyResponse {
  immediate: ImmediateSimulationResult
  historical: HistoricalSimulationResult
  simulationToken: string
  asOf: string
  effectiveConfig: Pick<
    EffectiveStrategyConfig,
    'strategyName' | 'targetAllocations' | 'riskCeiling'
  >
  dataCaveats: string[]
  label: string
}

/** Effective risk ceiling an ACTIVE goal imposes (goal wins — #281). */
type GoalSnapshot = NonNullable<StrategyParams['goal']> & {
  riskCeiling: number | null
}

interface OwnerContext {
  /** The caller's own parsed config (pre-follow merge). */
  own: StrategyConfigShape
  /** Config applied from the caller's CURRENT active follow, if any. */
  currentFollowApplied: StrategyConfigShape | null
}

/**
 * Load the caller's own config and current follow. Reads only the caller's rows.
 */
async function loadOwnerContext(userId: string): Promise<OwnerContext> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { rebalanceStrategy: true, strategyConfig: true },
  })
  if (!user) {
    throw new SimulationNotFoundError('User not found')
  }

  const own = parseStrategyConfig({
    strategyName: user.rebalanceStrategy ?? null,
    ...((user.strategyConfig as Record<string, unknown>) ?? {}),
  })

  const follow = await db.strategyFollow.findFirst({
    where: { followerUserId: userId, unfollowedAt: null },
    select: { publishedStrategy: { select: { strategyConfig: true } } },
  })
  const currentFollowApplied = follow
    ? parseStrategyConfig((follow as any).publishedStrategy?.strategyConfig)
    : null

  return { own, currentFollowApplied }
}

function stricter(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

/**
 * Resolve the effective config for the SIMULATION.
 *
 * Precedence (mirrors resolveEffectiveConfig / #285):
 *   1. A followed config — the caller's current follow, or the strategy named
 *      by the hypothetical `followStrategyId` when supplied.
 *   2. The submitted inline config (the "what if" target).
 *   3. The caller's own config.
 * The risk ceiling is ALWAYS clamped to the stricter of the caller's own and
 * any applied ceiling — a simulation may only ever tighten exposure.
 */
async function resolveSimulationEffectiveConfig(
  userId: string,
  req: SimulateStrategyRequest,
  ctx: OwnerContext
): Promise<EffectiveStrategyConfig> {
  let hypotheticalFollow = ctx.currentFollowApplied

  if (req.followStrategyId) {
    const target = await db.publishedStrategy.findUnique({
      where: { id: req.followStrategyId },
      select: { strategyConfig: true, isPublished: true },
    })
    if (!target || !target.isPublished) {
      throw new SimulationNotFoundError(
        'Published strategy not found or unpublished'
      )
    }
    hypotheticalFollow = parseStrategyConfig(target.strategyConfig)
  }

  const submitted: EffectiveStrategyConfig = {
    strategyName: req.strategy ?? null,
    targetAllocations: req.targetAllocations,
    riskCeiling: req.riskCeiling,
  }

  // No inline config, no follow: simulate the caller's current effective config
  // (a "what if nothing changes" baseline).
  const hasInline = req.strategy != null || req.targetAllocations !== undefined
  const useFollow = Boolean(req.followStrategyId) || !hasInline

  const base = useFollow ? hypotheticalFollow : submitted
  const fallbackStrategy =
    (hasInline ? submitted.strategyName : base?.strategyName) ??
    ctx.own.strategyName ??
    null

  const merged: EffectiveStrategyConfig = {
    strategyName: base?.strategyName ?? fallbackStrategy,
    targetAllocations:
      base?.targetAllocations ??
      submitted.targetAllocations ??
      ctx.own.targetAllocations,
    riskCeiling: stricter(
      submitted.riskCeiling,
      stricter(base?.riskCeiling, ctx.own.riskCeiling)
    ),
  }

  return merged
}

/** Load current protocol risk scores keyed by name (empty when no ceiling). */
async function loadRiskScores(): Promise<Record<string, number>> {
  const rows = await db.protocolRiskScore.findMany({
    select: { protocolName: true, score: true },
  })
  const map: Record<string, number> = {}
  for (const row of rows as Array<{ protocolName: string; score: number }>) {
    map[row.protocolName] = row.score
  }
  return map
}

/**
 * Run the what-if simulation for a caller. Throws SimulationValidationError for
 * rule violations (TARGET_ALLOCATION weights must sum to 100, GOAL_TRACKING
 * needs an active goal) and SimulationNotFoundError for missing owners/strategies.
 */
export async function simulateStrategy(
  userId: string,
  req: SimulateStrategyRequest
): Promise<SimulateStrategyResponse> {
  const historyWindowDays = Math.min(
    req.historyWindowDays ?? 90,
    SIMULATE_MAX_WINDOW_DAYS
  )

  const ctx = await loadOwnerContext(userId)

  const [goal] = await Promise.all([
    db.savingsGoal.findFirst({ where: { userId, status: 'ACTIVE' } }),
  ])
  const activeGoal: GoalSnapshot | null = goal
    ? {
        targetAmount: Number(goal.targetAmount),
        startingAmount: Number(goal.startingAmount),
        targetDate: goal.targetDate,
        riskCeiling: goal.riskCeiling,
      }
    : null

  if (req.strategy === 'GOAL_TRACKING' && !activeGoal) {
    throw new SimulationValidationError(
      'GOAL_TRACKING is driven by an active savings goal — none is active for this simulation'
    )
  }

  const effectiveConfig = await resolveSimulationEffectiveConfig(
    userId,
    req,
    ctx
  )

  // TARGET_ALLOCATION weights must sum to 100 (assumption 7 in #285).
  if (
    effectiveConfig.strategyName === 'TARGET_ALLOCATION' &&
    effectiveConfig.targetAllocations &&
    Object.keys(effectiveConfig.targetAllocations).length > 0
  ) {
    const total = Object.values(effectiveConfig.targetAllocations).reduce(
      (s, v) => s + v,
      0
    )
    if (Math.abs(total - 100) > 0.01) {
      throw new SimulationValidationError(
        `targetAllocations must sum to 100 (got ${total})`
      )
    }
  }

  // GOAL_TRACKING with a follow may carry no active goal of its own; the goal
  // precedence rule still requires one to simulate.
  if (effectiveConfig.strategyName === 'GOAL_TRACKING' && !activeGoal) {
    throw new SimulationValidationError(
      'GOAL_TRACKING is driven by an active savings goal — none is active for this simulation'
    )
  }

  const asOf = new Date().toISOString()
  const simulationToken = buildSimulationToken(
    effectiveConfig,
    historyWindowDays,
    asOf
  )

  const cacheKey = `strategy-simulate:${userId}:${simulationToken}`
  const cached = await cacheGet<SimulateStrategyResponse>(cacheKey)
  if (cached) {
    logger.info('[SimulateStrategy] cache hit', { userId })
    return cached
  }

  // ── Load current decision inputs ───────────────────────────────────────────
  const positions = await db.position.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { protocolName: true, currentValue: true },
  })
  const availableProtocols = await scanAllProtocols()
  const riskScores = await loadRiskScores()

  const goalForStrategy =
    effectiveConfig.strategyName === 'GOAL_TRACKING' && activeGoal
      ? {
          targetAmount: activeGoal.targetAmount,
          startingAmount: activeGoal.startingAmount,
          targetDate: activeGoal.targetDate,
        }
      : undefined

  // ── Immediate decision (zero side effects) ─────────────────────────────────
  const immediate = await simulateImmediate({
    positions: positions.map((p) => ({
      protocolName: p.protocolName,
      currentValue: p.currentValue.toString(),
    })),
    effectiveConfig,
    thresholds: getThresholds(),
    riskScores,
    availableProtocols,
    goal: goalForStrategy,
    asOf: new Date(asOf),
  })

  // ── Historical replay (zero side effects) ──────────────────────────────────
  const now = new Date()
  const windowStart = new Date(
    now.getTime() - historyWindowDays * 24 * 60 * 60 * 1000
  )
  const rawRates = await db.protocolRate.findMany({
    where: { fetchedAt: { gte: windowStart, lte: now } },
    select: {
      protocolName: true,
      assetSymbol: true,
      supplyApy: true,
      fetchedAt: true,
    },
    orderBy: { fetchedAt: 'asc' },
  })
  const rawPoints = rawRates.map((r) => ({
    protocolName: r.protocolName,
    assetSymbol: r.assetSymbol,
    apy: Number(r.supplyApy),
    date: r.fetchedAt,
  }))

  const { series: dailyRates, dataCaveats: windowCaveats } =
    buildSimulationRateSeries(
      rawPoints,
      windowStart,
      now,
      SIMULATE_MAX_WINDOW_DAYS
    )

  // Missing protocol history for protocols in the target set => caveat, treated
  // as unavailable (never zero-filled) by the replay.
  const protocolsInScope = new Set(
    Object.keys(effectiveConfig.targetAllocations ?? {})
  )
  const availableNames = new Set(
    dailyRates.flatMap((d) => d.protocols.map((p) => p.name))
  )
  const missingScope = protocolNamesMissing(protocolsInScope, availableNames)
  if (missingScope.length > 0) {
    windowCaveats.push(
      `No retained history for protocol(s): ${missingScope.join(', ')} — treated as unavailable for those steps (never zero-filled)`
    )
  }

  // Anchor the replay on the caller's current position value when available;
  // otherwise a hypothetical unit deposit per the request flag. The starting
  // protocol is the caller's highest-value position (matches the immediate
  // decision's anchor).
  const anchor = positions.reduce<{
    total: number
    top: { protocolName: string; currentValue: number } | null
  }>(
    (acc, p) => {
      const v = Number(p.currentValue)
      acc.total += v
      if (!acc.top || v > acc.top.currentValue) {
        acc.top = { protocolName: p.protocolName, currentValue: v }
      }
      return acc
    },
    { total: 0, top: null }
  )
  const startingAmount =
    anchor.total > 0
      ? anchor.total.toFixed(6)
      : req.assumeInitialDeposit
        ? '1000'
        : '0'
  const startingProtocol = anchor.top?.protocolName ?? null

  const historical = await simulateHistorical({
    startingAmount,
    startingProtocol,
    effectiveConfig,
    thresholds: getThresholds(),
    riskScores,
    dailyRates,
    dataCaveats: windowCaveats,
    goal: goalForStrategy,
    userId,
  })

  const response: SimulateStrategyResponse = {
    immediate,
    historical,
    simulationToken,
    asOf,
    effectiveConfig: {
      strategyName: effectiveConfig.strategyName,
      targetAllocations: effectiveConfig.targetAllocations,
      riskCeiling: effectiveConfig.riskCeiling,
    },
    dataCaveats: historical.dataCaveats,
    label: SIMULATION_LABEL,
  }

  await cacheSet(cacheKey, response, SIMULATION_CACHE_TTL)

  return response
}

function protocolNamesMissing(
  inScope: Set<string>,
  available: Set<string>
): string[] {
  const missing: string[] = []
  for (const name of inScope) {
    if (!available.has(name)) missing.push(name)
  }
  return missing.sort()
}
