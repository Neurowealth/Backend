/**
 * Router - Compares APYs and triggers rebalancing when conditions are met
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { ProtocolComparison, RebalanceDetails, RebalanceThresholds } from './types';
import { scanAllProtocols, getCurrentOnChainApy } from './scanner';
import { triggerRebalance as submitRebalance } from '../stellar/contract';

const prisma = new PrismaClient();

const DEFAULT_THRESHOLDS: RebalanceThresholds = {
  minimumImprovement: 0.5, // Must improve by at least 0.5%
  maxGasPercent: 0.1,
};

function toApyBasisPoints(apyPercent: number): number {
  if (!Number.isFinite(apyPercent) || apyPercent < 0) {
    throw new Error('APY must be a non-negative number');
  }

  return Math.round(apyPercent * 100);
}

/**
 * Estimate transaction costs for a rebalance
 * Accounts for gas fees and potential DEX slippage
 */
function estimateRebalanceCosts(
  amount: string,
  maxGasPercent: number
): { gasFeePercent: number; slippagePercent: number; totalCostPercent: number } {
  // Estimate gas fee based on amount
  // Typical Stellar Soroban gas: ~270-300 stroops base, plus per-instruction fees
  const gasEstimateUSD = 0.50; // Estimate $0.50 base gas
  const amountUSD = parseInt(amount) / 1e18; // Assuming amount is in wei
  const gasFeePercent = amountUSD > 0 ? (gasEstimateUSD / amountUSD) * 100 : 0;

  // Estimate DEX slippage (typically 0.1-0.5% on significant trades)
  const slippagePercent = Math.min(maxGasPercent * 0.5, 0.25);

  return {
    gasFeePercent: Math.min(gasFeePercent, maxGasPercent),
    slippagePercent,
    totalCostPercent: Math.min(gasFeePercent + slippagePercent, maxGasPercent),
  };
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
    const currentApy = await getCurrentOnChainApy(currentProtocol);
    if (!currentApy) {
      logger.warn(`Cannot get current APY for ${currentProtocol}`);
      return null;
    }

    // Get best available protocol from latest scan
    const allProtocols = await scanAllProtocols();
    if (allProtocols.length === 0) {
      logger.warn('No protocols available for comparison');
      return null;
    }

    const bestProtocol = allProtocols[0];
    const rawImprovement = bestProtocol.apy - currentApy;

    // CRITICAL: Account for rebalance costs (gas + slippage)
    const costs = estimateRebalanceCosts(amount, thresholds.maxGasPercent);
    const netImprovement = rawImprovement - costs.totalCostPercent;

    // Only rebalance if NET improvement (after costs) exceeds threshold
    const shouldRebalance =
      netImprovement > thresholds.minimumImprovement &&
      bestProtocol.name !== currentProtocol &&
      costs.totalCostPercent < thresholds.maxGasPercent;

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
    };

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
    });

    return comparison;
  } catch (error) {
    logger.error('Protocol comparison failed', {
      currentProtocol,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
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
): Promise<RebalanceDetails | null> {
  const startTime = Date.now();

  try {
    const comparison = await compareProtocols(fromProtocol, amount);
    if (!comparison) {
      throw new Error(`Unable to compare protocols for ${fromProtocol}`);
    }

    const expectedApyBasisPoints = toApyBasisPoints(comparison.best.apy);

    logger.info('Rebalance triggered', {
      fromProtocol,
      toProtocol,
      amount,
      expectedApyBasisPoints,
    });

    const onChainTransaction = await submitRebalance(
      toProtocol,
      expectedApyBasisPoints,
    );

    if (positionIds.length > 0) {
      const representativePosition = await prisma.position.findFirst({
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
      });

      if (representativePosition) {
        await prisma.transaction.create({
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
        });
      } else {
        logger.warn('No position found to persist rebalance transaction', {
          fromProtocol,
          toProtocol,
          positionIds,
        });
      }
    }

    const rebalanceDetail: RebalanceDetails = {
      fromProtocol,
      toProtocol,
      amount,
      txHash: onChainTransaction.hash,
      timestamp: new Date(),
      improvedBy: comparison.improvement,
    };

    const duration = Date.now() - startTime;

    // Log to database
    await logAgentAction('REBALANCE', 'SUCCESS', {
      rebalanceDetail,
    });

    logger.info('Rebalance successful', {
      txHash: onChainTransaction.hash,
      duration,
      improvedBy: comparison.improvement.toFixed(2),
    });

    return rebalanceDetail;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logger.error('Rebalance failed', {
      fromProtocol,
      toProtocol,
      amount,
      error: errorMessage,
      duration,
    });

    await logAgentAction('REBALANCE', 'FAILED', {
      fromProtocol,
      toProtocol,
      error: errorMessage,
    });

    return null;
  }
}

/**
 * Execute rebalance if conditions are met
 * Accounts for transaction costs in decision
 */
export async function executeRebalanceIfNeeded(
  currentProtocol: string,
  userPositions: Array<{ id: string; amount: string }>,
  thresholds?: RebalanceThresholds
): Promise<RebalanceDetails | null> {
  try {
    // Sum all user positions FIRST to account for costs
    const totalAmount = userPositions
      .reduce(
        (sum, pos) => sum + BigInt(pos.amount),
        BigInt(0)
      )
      .toString();

    // FIXED: Pass totalAmount to compareProtocols so it can account for transaction costs
    const comparison = await compareProtocols(currentProtocol, totalAmount, thresholds);

    if (!comparison || !comparison.shouldRebalance) {
      logger.info('No rebalance needed', {
        reason: comparison
          ? `Net improvement ${comparison.improvement.toFixed(2)}% (after fees) below threshold`
          : 'Unable to compare protocols',
      });
      return null;
    }

    return await triggerRebalance(
      currentProtocol,
      comparison.best.name,
      totalAmount,
      userPositions.map(pos => pos.id),
    );
  } catch (error) {
    logger.error('Rebalance execution check failed', {
      currentProtocol,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Log agent action to database
 */
export async function logAgentAction(
  action: string,
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED',
  data?: Record<string, unknown>
): Promise<void> {
  try {
    // Log to all users for now - in production, could be per-user
    const users = await prisma.user.findMany({
      select: { id: true },
      take: 1, // For now, just log to first user
    });

    if (users.length === 0) {
      logger.warn('No users found for agent logging');
      return;
    }

    const userId = users[0].id;

    await prisma.agentLog.create({
      data: {
        userId,
        action: action as any,
        status: status as any,
        inputData: data?.input ? JSON.stringify(data.input) : undefined,
        outputData: data?.output ? JSON.stringify(data.output) : undefined,
        reasoning: data?.reasoning as string | undefined,
        errorMessage: data?.error as string | undefined,
      },
    });
  } catch (error) {
    logger.error('Failed to log agent action', {
      action,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
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
    maxGasPercent: parseFloat(
      process.env.MAX_GAS_PERCENT || '0.1'
    ),
  };
}
