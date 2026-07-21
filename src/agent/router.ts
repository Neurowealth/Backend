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
} from './types'
import { scanAllProtocols, getCurrentOnChainApy } from './scanner'
import { triggerRebalance as submitRebalance } from '../stellar/contract'
import {
  MaxYieldStrategy,
  TargetAllocationStrategy,
  GoalTrackingStrategy,
} from './strategies'
import db from '../db'

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
 * Estimate transaction costs for a rebalance
 * Accounts for gas fees and potential DEX slippage
 */
function estimateRebalanceCosts(
  amount: string,
  maxGasPercent: number
): {
  gasFeePercent: number
  slippagePercent: number
  totalCostPercent: number
} {
  // Estimate gas fee based on amount
  // Typical Stellar Soroban gas: ~270-300 stroops base, plus per-instruction fees
  const gasEstimateUSD = 0.5 // Estimate $0.50 base gas
  const amountUSD = parseInt(amount) / 1e18 // Assuming amount is in wei
  const gasFeePercent = amountUSD > 0 ? (gasEstimateUSD / amountUSD) * 100 : 0

  // Estimate DEX slippage (typically 0.1-0.5% on significant trades)
  const slippagePercent = Math.min(maxGasPercent * 0.5, 0.25)

  return {
    gasFeePercent: Math.min(gasFeePercent, maxGasPercent),
    slippagePercent,
    totalCostPercent: Math.min(gasFeePercent + slippagePercent, maxGasPercent),
  }
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

    // CRITICAL: Account for rebalance costs (gas + slippage)
    const costs = estimateRebalanceCosts(amount, thresholds.maxGasPercent)
    const netImprovement = rawImprovement - costs.totalCostPercent

    // Only rebalance if NET improvement (after costs) exceeds threshold
    const shouldRebalance =
      netImprovement > thresholds.minimumImprovement &&
      bestProtocol.name !== currentProtocol &&
      costs.totalCostPercent < thresholds.maxGasPercent

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
      gasFeePercent: costs.gasFeePercent.toFixed(4),
      slippagePercent: costs.slippagePercent.toFixed(4),
      totalCostPercent: costs.totalCostPercent.toFixed(4),
      netImprovement: netImprovement.toFixed(2),
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
  strategyInfo?: { name: string; reasoning: string; deviationTrigger?: string }
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

    const onChainTransaction = await submitRebalance(
      toProtocol,
      expectedApyBasisPoints
    )

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
        await db.transaction.create({
          data: {
            userId: representativePosition.userId,
            positionId: representativePosition.id,
            txHash: onChainTransaction.hash,
            type: 'REBALANCE',
            status: 'PENDING',
            assetSymbol: representativePosition.assetSymbol,
            amount,
            network: representativePosition.user.network,
            protocolName: toProtocol,
            memo: `Agent rebalance from ${fromProtocol} to ${toProtocol}`,
          } as any,
        })
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
      txHash: onChainTransaction.hash,
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
      })
    }

    logger.info('Rebalance successful', {
      txHash: onChainTransaction.hash,
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
      })

      if (!decision.shouldRebalance) {
        logger.info('No rebalance needed (strategy)', {
          strategy: strategy.name,
          reasoning: decision.reasoning,
        })
        return null
      }

      return await triggerRebalance(
        currentProtocol,
        decision.targetProtocol,
        totalAmount,
        userPositions.map((pos) => pos.id),
        {
          name: strategy.name,
          reasoning: decision.reasoning,
          deviationTrigger: decision.deviationTrigger,
        }
      )
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
