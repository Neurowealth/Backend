/**
 * Router - Compares APYs and triggers rebalancing when conditions are met
 */

import { logger } from '../utils/logger'
import { getCorrelationId } from '../utils/correlation'
import {
  ProtocolComparison,
  RebalanceDetails,
  RebalanceThresholds,
  RebalanceStrategy,
  UserStrategyPreferences,
  ExposureContext,
} from './types'
import { scanAllProtocols, getCurrentOnChainApy } from './scanner'
import {
  MaxYieldStrategy,
  TargetAllocationStrategy,
  GoalTrackingStrategy,
} from './strategies'
import {
  resolveExposureCap,
  buildExposureSnapshot,
  planCappedRebalance,
  EffectiveExposureCap,
  ExposureSnapshot,
  CappedAllocationPlan,
  sumCaps,
} from './exposureCaps'
import { estimateRebalanceCost, passesPaybackGate } from './rebalanceCost'
import db from '../db'
import { enqueueOutboxOp } from '../outbox/service'
import { dispatchInBackground } from '../outbox/dispatcher'
import { deriveIdempotencyKey } from '../outbox/idempotency'

const DEFAULT_THRESHOLDS: RebalanceThresholds = {
  minimumImprovement: 0.5, // Must improve by at least 0.5%
  maxGasPercent: 0.1,
}

/**
 * Load current protocol risk scores keyed by protocol name.
 *
 * Only called when a user has actually configured a riskCeiling, so the default
 * (no-ceiling) rebalancing path issues no extra query and is unaffected. A
 * protocol absent from this map is treated as ineligible under a ceiling
 * (fail-closed) by the strategy engine.
 */
async function loadProtocolRiskScores(): Promise<Record<string, number>> {
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
 * Load a user's ACTIVE savings goal (#281), if any. Only called when
 * userStrategyPreferences are present, so users who never create a goal issue
 * no extra query beyond this single lookup.
 */
async function loadActiveGoal(userId: string): Promise<{
  targetAmount: number
  startingAmount: number
  targetDate: Date
  riskCeiling: number | null
} | null> {
  const goal = await db.savingsGoal.findFirst({
    where: { userId, status: 'ACTIVE' },
  })
  if (!goal) return null
  return {
    targetAmount: Number(goal.targetAmount),
    startingAmount: Number(goal.startingAmount),
    targetDate: goal.targetDate,
    riskCeiling: goal.riskCeiling,
  }
}

function toApyBasisPoints(apyPercent: number): number {
  if (!Number.isFinite(apyPercent) || apyPercent < 0) {
    throw new Error('APY must be a non-negative number')
  }

  return Math.round(apyPercent * 100)
}

/**
 * Build the exposure map + resolved caps for a user's WHOLE active portfolio
 * (#346). The rebalancer sees one protocol batch at a time; this queries the
 * caller's remaining active positions so cap enforcement always has the full
 * per-protocol split, never just the batch.
 *
 * Returns null when the user has no caps or risk framing configured (the
 * default path) — the caller then behaves byte-for-byte as before.
 */
async function buildExposureContextForUser(
  userIds: string[],
  preferences: UserStrategyPreferences[]
): Promise<{
  exposure: ExposureContext
  snapshot: ExposureSnapshot
  caps: Record<string, EffectiveExposureCap>
} | null> {
  const pref = preferences[0]
  const hasAnyConfiguredCap =
    Boolean(pref?.exposureCaps) ||
    typeof pref?.defaultMaxFraction === 'number' ||
    pref?.riskTolerance !== undefined

  // Caps are opt-in: with no override and no riskTolerance framing, no cap can
  // ever bind, so we skip the extra exposure query entirely (matches the
  // no-ceiling query-savings contract elsewhere in this file).
  if (!pref || !hasAnyConfiguredCap) return null

  const riskTolerance = pref.riskTolerance ?? 5
  const overrideConfig = pref.exposureCaps
    ? {
        perProtocol: pref.exposureCaps,
        defaultMaxFraction: pref.defaultMaxFraction,
      }
    : typeof pref.defaultMaxFraction === 'number'
      ? { defaultMaxFraction: pref.defaultMaxFraction }
      : undefined

  const positions = await db.position.findMany({
    where: {
      userId: { in: userIds },
      status: 'ACTIVE',
    },
    select: { protocolName: true, currentValue: true },
  })

  const absolute: Record<string, number> = {}
  for (const p of positions) {
    absolute[p.protocolName] =
      (absolute[p.protocolName] ?? 0) + Number(p.currentValue)
  }

  const snapshot = buildExposureSnapshot(absolute)
  const protocols = Object.keys(absolute)
  const caps = resolveExposureCap(protocols, riskTolerance, overrideConfig)

  const overCap = protocols.filter(
    (p) => (snapshot.fractions[p] ?? 0) > caps[p].maxFraction + 1e-12
  )
  const capSum = sumCaps(protocols, snapshot, caps)

  return {
    exposure: {
      fractions: snapshot.fractions,
      caps: Object.fromEntries(
        Object.entries(caps).map(([p, c]) => [
          p,
          {
            maxFraction: c.maxFraction,
            maxAbsolute: c.maxAbsolute,
            source: c.source,
          },
        ])
      ),
      overCap,
      unplaceable: capSum < 1 - 1e-9,
    },
    snapshot,
    caps,
  }
}

/**
 * Route a strategy's target preference into a cap-compliant allocation plan
 * (#346). When caps are absent this returns a single full allocation to the
 * preferred target — the exact pre-feature behavior, so the no-cap path never
 * splits a move it did not before.
 */
function planFromStrategyDecision(
  currentProtocol: string,
  targetProtocol: string,
  totalAmount: string,
  snapshot: ExposureSnapshot,
  caps: Record<string, EffectiveExposureCap>
): CappedAllocationPlan {
  if (Number(totalAmount) <= 0) {
    return { allocations: [], unplacedFraction: 0, overCapProtocols: [] }
  }

  // Rank: preferred target first, then the rest of the user's held protocols
  // sorted by their fraction descending (fill next-best under its own cap).
  const others = Object.keys(caps)
    .filter((p) => p !== targetProtocol && p !== currentProtocol)
    .sort((a, b) => (snapshot.fractions[b] ?? 0) - (snapshot.fractions[a] ?? 0))
  const preferredOrder = [targetProtocol, currentProtocol, ...others]

  return planCappedRebalance(preferredOrder, 1, snapshot, caps)
}

/**
 * Compare current protocol APY with best available APY
 * Accounts for network fees and slippage - only rebalances if NET gain > 0.5%
 */
export async function compareProtocols(
  currentProtocol: string,
  amount: string = '0',
  thresholds: RebalanceThresholds = DEFAULT_THRESHOLDS
): Promise<ProtocolComparison | null> {
  try {
    // Get current on-chain APY
    const currentApy = await getCurrentOnChainApy(currentProtocol)
    if (!currentApy) {
      logger.warn(`Cannot get current APY for ${currentProtocol}`)
      return null
    }

    // Get best available protocol from latest scan
    const allProtocols = await scanAllProtocols()
    if (allProtocols.length === 0) {
      logger.warn('No protocols available for comparison')
      return null
    }

    const bestProtocol = allProtocols[0]
    const rawImprovement = bestProtocol.apy - currentApy

    // CRITICAL: Account for rebalance costs (network fee + slippage + entry/exit)
    // via the grounded #347 model, and gate the move on the payback horizon.
    const cost = estimateRebalanceCost({
      fromProtocol: currentProtocol,
      toProtocol: bestProtocol.name,
      amount,
      // Same-asset hop between lending protocols (no swap, hence no simulated
      // price impact). Cross-asset paths would pass sameAsset:false.
      sameAsset: true,
      feeSnapshot: null, // no live oracle wired through the default path yet
    })
    const netImprovement = rawImprovement - cost.totalCostPct
    const payback = passesPaybackGate(cost, currentApy, bestProtocol.apy)

    // Fallback confidence → require a higher minimum (more cautious when blind).
    const effectiveMinimum =
      cost.dataConfidence === 'fallback'
        ? thresholds.minimumImprovement * 2
        : thresholds.minimumImprovement

    // Only rebalance if NET improvement (after costs) exceeds threshold and the
    // move recoups its cost within the payback horizon.
    const shouldRebalance =
      bestProtocol.name !== currentProtocol &&
      netImprovement > effectiveMinimum &&
      payback.allowed

    const comparison: ProtocolComparison = {
      current: {
        name: currentProtocol,
        apy: currentApy,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
      best: bestProtocol,
      improvement: netImprovement,
      shouldRebalance,
    }

    logger.info('Protocol comparison complete', {
      currentProtocol,
      currentApy,
      bestProtocol: bestProtocol.name,
      bestApy: bestProtocol.apy,
      rawImprovement: rawImprovement.toFixed(2),
      networkFeePercent: cost.networkFeePctOfAmount.toFixed(4),
      priceImpactBps: cost.priceImpactBps,
      totalCostPercent: cost.totalCostPct.toFixed(4),
      netImprovement: netImprovement.toFixed(2),
      paybackDays: payback.paybackDays,
      shouldRebalance,
    })

    return comparison
  } catch (error) {
    logger.error('Protocol comparison failed', {
      currentProtocol,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  }
}

/**
 * Trigger on-chain rebalance
 * In production, this would call the actual smart contract
 */
export async function triggerRebalance(
  fromProtocol: string,
  toProtocol: string,
  amount: string,
  positionIds: string[] = [],
  strategyInfo?: {
    name: string
    reasoning: string
    deviationTrigger?: string
    /** PublishedStrategy this config was copied from (#285). Attribution only. */
    followedStrategyId?: string | null
  }
): Promise<RebalanceDetails | null> {
  const startTime = Date.now()

  try {
    const comparison = await compareProtocols(fromProtocol, amount)
    if (!comparison) {
      throw new Error(`Unable to compare protocols for ${fromProtocol}`)
    }

    const expectedApyBasisPoints = toApyBasisPoints(comparison.best.apy)

    logger.info('Rebalance triggered', {
      fromProtocol,
      toProtocol,
      amount,
      expectedApyBasisPoints,
    })

    // #325: a rebalance is a LOW-priority, durable, NON-BLOCKING outbox op —
    // the loop enqueues the intent (transactionally with the Transaction row)
    // and moves on without waiting for the on-chain round trip. The
    // background dispatcher (src/outbox/dispatcher.ts) submits it on its own
    // cadence, and the event listener confirms the linked Transaction row
    // when the on-chain event arrives. txHash is therefore not known yet at
    // this point — RebalanceDetails.txHash is left undefined.
    let txHash: string | undefined

    if (positionIds.length > 0) {
      const representativePosition = await db.position.findFirst({
        where: {
          id: { in: positionIds },
        },
        include: {
          user: {
            select: {
              network: true,
            },
          },
        },
      })

      if (representativePosition) {
        const opId = await db.$transaction(async (tx) => {
          const transaction = await tx.transaction.create({
            data: {
              userId: representativePosition.userId,
              positionId: representativePosition.id,
              type: 'REBALANCE',
              status: 'PENDING',
              assetSymbol: representativePosition.assetSymbol,
              amount,
              network: representativePosition.user.network,
              protocolName: toProtocol,
              memo: `Agent rebalance from ${fromProtocol} to ${toProtocol}`,
            } as any,
          })

          const op = await enqueueOutboxOp(tx, {
            idempotencyKey: deriveIdempotencyKey(
              'REBALANCE',
              representativePosition.userId,
              transaction.id
            ),
            userId: representativePosition.userId,
            kind: 'REBALANCE',
            actor: 'AGENT',
            payload: {
              method: 'rebalance',
              toProtocol,
              expectedApyBasisPoints,
              transactionId: transaction.id,
            },
          })

          return op.id
        })

        dispatchInBackground(opId)
      } else {
        logger.warn('No position found to persist rebalance transaction', {
          fromProtocol,
          toProtocol,
          positionIds,
        })
      }
    }

    const rebalanceDetail: RebalanceDetails = {
      fromProtocol,
      toProtocol,
      amount,
      txHash,
      timestamp: new Date(),
      improvedBy: comparison.improvement,
    }

    const duration = Date.now() - startTime

    // Log to database – attribute to the actual user(s) for each affected position
    if (positionIds.length > 0) {
      const affectedPositions = await db.position.findMany({
        where: { id: { in: positionIds } },
        select: { id: true, userId: true },
      })

      // Deduplicate: one log per (userId, positionId) pair
      const seen = new Set<string>()
      for (const pos of affectedPositions) {
        const key = `${pos.userId}:${pos.id}`
        if (seen.has(key)) continue
        seen.add(key)
        await logAgentAction(
          'REBALANCE',
          'SUCCESS',
          {
            rebalanceDetail,
            strategyName: strategyInfo?.name,
            reasoning: strategyInfo?.reasoning,
            deviationTrigger: strategyInfo?.deviationTrigger,
            followedStrategyId: strategyInfo?.followedStrategyId,
          },
          pos.userId,
          pos.id
        )
      }
    } else {
      // No positions linked – log as system-level (userId stays null)
      await logAgentAction('REBALANCE', 'SUCCESS', {
        rebalanceDetail,
        strategyName: strategyInfo?.name,
        reasoning: strategyInfo?.reasoning,
        deviationTrigger: strategyInfo?.deviationTrigger,
        followedStrategyId: strategyInfo?.followedStrategyId,
      })
    }

    logger.info('Rebalance queued (durable, dispatched asynchronously)', {
      duration,
      improvedBy: comparison.improvement.toFixed(2),
    })

    return rebalanceDetail
  } catch (error) {
    const duration = Date.now() - startTime
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    logger.error('Rebalance failed', {
      fromProtocol,
      toProtocol,
      amount,
      error: errorMessage,
      duration,
    })

    await logAgentAction('REBALANCE', 'FAILED', {
      fromProtocol,
      toProtocol,
      error: errorMessage,
    })

    return null
  }
}

/**
 * Execute rebalance if conditions are met
 * Accounts for transaction costs in decision
 */
export async function executeRebalanceIfNeeded(
  currentProtocol: string,
  userPositions: Array<{ id: string; amount: string; userId?: string }>,
  thresholds?: RebalanceThresholds,
  userStrategyPreferences?: UserStrategyPreferences[]
): Promise<RebalanceDetails | null> {
  try {
    const totalAmount = userPositions
      .reduce((sum, pos) => sum + BigInt(pos.amount), BigInt(0))
      .toString()

    const effectiveThresholds = thresholds ?? getThresholds()

    // Use strategy engine when user preferences are present
    if (userStrategyPreferences && userStrategyPreferences.length > 0) {
      const currentApy = await getCurrentOnChainApy(currentProtocol)
      if (!currentApy) {
        logger.warn(`Cannot get current APY for ${currentProtocol}`)
        return null
      }

      const allProtocols = await scanAllProtocols()
      if (allProtocols.length === 0) {
        logger.warn('No protocols available for comparison')
        return null
      }

      // An ACTIVE savings goal (#281) takes priority over the stored strategy
      // preference — a user working toward a stated target/date should have
      // the agent chase whatever rate that goal actually needs, not a static
      // preference that predates the goal. Users with no goal fall through to
      // the existing preference logic completely unchanged.
      const goalUserId = userStrategyPreferences[0]?.userId
      const activeGoal = goalUserId ? await loadActiveGoal(goalUserId) : null

      const preferredStrategy = userStrategyPreferences[0]?.strategyName
      const strategy: RebalanceStrategy = activeGoal
        ? new GoalTrackingStrategy()
        : preferredStrategy === 'TARGET_ALLOCATION'
          ? new TargetAllocationStrategy()
          : new MaxYieldStrategy()

      // Risk ceiling is opt-in per user (or per goal). Only when a ceiling is
      // set do we load the current ProtocolRiskScore rows and pass them to the
      // strategy — the no-ceiling path issues no extra query and behaves
      // exactly as before.
      const riskCeiling =
        activeGoal?.riskCeiling ??
        userStrategyPreferences[0]?.riskCeiling ??
        undefined
      const protocolRiskScores =
        riskCeiling !== undefined ? await loadProtocolRiskScores() : undefined

      // Exposure caps (#346): build the user's whole-portfolio exposure context
      // once per tick. Null when no caps/riskTolerance framing is configured —
      // the no-cap path is byte-for-byte the pre-feature behavior.
      const userIds = Array.from(
        new Set(userStrategyPreferences.map((p) => p.userId))
      )
      const exposureContext = await buildExposureContextForUser(
        userIds,
        userStrategyPreferences
      )

      const decision = await strategy.analyze({
        currentProtocol,
        totalAmount,
        currentApy,
        availableProtocols: allProtocols,
        thresholds: effectiveThresholds,
        userStrategyPreferences,
        riskCeiling,
        protocolRiskScores,
        goal: activeGoal
          ? {
              targetAmount: activeGoal.targetAmount,
              startingAmount: activeGoal.startingAmount,
              targetDate: activeGoal.targetDate,
            }
          : undefined,
        exposure: exposureContext?.exposure,
      })

      if (
        decision.shouldRebalance &&
        decision.targetProtocol !== currentProtocol
      ) {
        // Apply exposure caps to the strategy's target choice: clamp the move
        // and route any residual to the next-best eligible protocol under its
        // own cap. With no caps this is a single full move, unchanged.
        const plan = exposureContext
          ? planFromStrategyDecision(
              currentProtocol,
              decision.targetProtocol,
              totalAmount,
              exposureContext.snapshot,
              exposureContext.caps
            )
          : {
              allocations: [
                {
                  protocol: decision.targetProtocol,
                  fraction: 1,
                  capped: false,
                  boundedBy: 'none' as const,
                },
              ],
              unplacedFraction: 0,
              overCapProtocols: [] as string[],
            }

        // If the preferred target itself had zero headroom, still try a real
        // move into the next allocation; otherwise nothing can move.
        const moves = plan.allocations
          .filter((a) => a.fraction > 0 && a.protocol !== currentProtocol)
          .map((a) => ({
            toProtocol: a.protocol,
            fraction: a.fraction,
            capped: a.capped,
            boundedBy: a.boundedBy,
          }))

        if (moves.length === 0) {
          // Either already on target or the caps made every allocation zero.
          if (plan.unplacedFraction > 0) {
            await logAgentAction('REBALANCE', 'SKIPPED', {
              input: {
                currentProtocol,
                targetProtocol: decision.targetProtocol,
                reasoning: decision.reasoning,
                event: 'agent.exposure_unplaceable',
                reason:
                  'Sum of exposure caps over the eligible set is below 100%; remainder stays in place.',
              },
            })
          }
          logger.info('No cap-compliant move possible; remainder stays put', {
            currentProtocol,
            targetProtocol: decision.targetProtocol,
            unplacedFraction: plan.unplacedFraction,
          })
          return null
        }

        // Execute the first cap-compliant move (the largest non-zero allocation,
        // which is the preferred target unless it was full). Residual that could
        // not be placed stays in place per the unplaceable contract.
        const first = moves[0]
        const amountToMove = BigInt(
          Math.floor(Number(totalAmount) * first.fraction)
        )
        logger.info('Capped rebalance move', {
          from: currentProtocol,
          to: first.toProtocol,
          fractionOfPortfolio: first.fraction,
          capped: first.capped,
          boundedBy: first.boundedBy,
          unplacedFraction: plan.unplacedFraction,
        })

        return await triggerRebalance(
          currentProtocol,
          first.toProtocol,
          amountToMove.toString(),
          userPositions.map((pos) => pos.id),
          {
            name: strategy.name,
            reasoning: decision.reasoning,
            deviationTrigger: decision.deviationTrigger,
            followedStrategyId: userStrategyPreferences[0]?.followedStrategyId,
          }
        )
      }

      if (!decision.shouldRebalance) {
        // Over-cap correction (#346): even when APY alone wouldn't trigger a
        // move, if the user is currently over a cap on a held protocol the next
        // tick should reduce it toward the cap. Without a cost model yet, this
        // surfaces the over-cap state via the decision record and skips the
        // move (the fee-aware rebalancing issue #347 adds the cost gate that
        // makes the correction actually fire).
        logger.info('No rebalance needed (strategy)', {
          strategy: strategy.name,
          reasoning: decision.reasoning,
          overCapProtocols: exposureContext?.exposure.overCap ?? [],
          capConstraints: Object.entries(
            exposureContext?.exposure.caps ?? {}
          ).map(([p, c]) => ({
            protocol: p,
            maxFraction: c.maxFraction,
            maxAbsolute: c.maxAbsolute ?? undefined,
            source: c.source,
          })),
          unplaceable: exposureContext?.exposure.unplaceable ?? false,
        })
        return null
      }

      // strategy said rebalance to the protocol we're already on — nothing to do.
      return null
    }

    // Default: existing compareProtocols flow (backward compatible)
    const comparison = await compareProtocols(
      currentProtocol,
      totalAmount,
      effectiveThresholds
    )

    if (!comparison || !comparison.shouldRebalance) {
      logger.info('No rebalance needed', {
        reason: comparison
          ? `Net improvement ${comparison.improvement.toFixed(2)}% (after fees) below threshold`
          : 'Unable to compare protocols',
      })
      return null
    }

    return await triggerRebalance(
      currentProtocol,
      comparison.best.name,
      totalAmount,
      userPositions.map((pos) => pos.id),
      {
        name: 'MAX_YIELD',
        reasoning: `Moving from ${currentProtocol} to ${comparison.best.name} — net gain ${comparison.improvement.toFixed(2)}% after costs`,
        deviationTrigger: `APY delta: ${(comparison.best.apy - comparison.current.apy).toFixed(2)}%`,
      }
    )
  } catch (error) {
    logger.error('Rebalance execution check failed', {
      currentProtocol,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  }
}

/**
 * Log agent action to database.
 *
 * - Pass `userId` when the action is attributable to a specific user
 *   (e.g. rebalance for that user's position).
 * - Pass `positionId` when the action affects a specific position.
 * - Omit both (or pass undefined) for system-level actions such as
 *   protocol scans or aggregate health-checks; the log row will have
 *   a null userId so it is distinguishable from user-level actions.
 */
export async function logAgentAction(
  action: string,
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED',
  data?: Record<string, unknown>,
  userId?: string,
  positionId?: string
): Promise<void> {
  const correlationId = getCorrelationId()
  const inputWithCorrelation =
    data?.input || correlationId
      ? {
          ...(typeof data?.input === 'object' && data.input !== null
            ? data.input
            : {}),
          ...(correlationId ? { correlationId } : {}),
        }
      : undefined

  try {
    await db.agentLog.create({
      data: {
        userId: userId ?? null,
        positionId: positionId ?? null,
        action: action as any,
        status: status as any,
        inputData: inputWithCorrelation
          ? JSON.stringify(inputWithCorrelation)
          : data?.input
            ? JSON.stringify(data.input)
            : undefined,
        outputData: data?.output ? JSON.stringify(data.output) : undefined,
        reasoning: data?.reasoning as string | undefined,
        errorMessage: data?.error as string | undefined,
      },
    })
  } catch (error) {
    logger.error('Failed to log agent action', {
      action,
      userId,
      positionId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Get rebalance threshold configuration
 */
export function getThresholds(): RebalanceThresholds {
  return {
    minimumImprovement: parseFloat(
      process.env.REBALANCE_THRESHOLD_PERCENT || '0.5'
    ),
    maxGasPercent: parseFloat(process.env.MAX_GAS_PERCENT || '0.1'),
  }
}
