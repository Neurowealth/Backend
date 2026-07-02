import {
  RebalanceStrategy,
  StrategyName,
  StrategyDecision,
  StrategyParams,
} from './types';
import { logger } from '../utils/logger';

function estimateRebalanceCosts(
  amount: string,
  maxGasPercent: number
): { gasFeePercent: number; slippagePercent: number; totalCostPercent: number } {
  const gasEstimateUSD = 0.50;
  const amountUSD = parseInt(amount) / 1e18;
  const gasFeePercent = amountUSD > 0 ? (gasEstimateUSD / amountUSD) * 100 : 0;
  const slippagePercent = Math.min(maxGasPercent * 0.5, 0.25);

  return {
    gasFeePercent: Math.min(gasFeePercent, maxGasPercent),
    slippagePercent,
    totalCostPercent: Math.min(gasFeePercent + slippagePercent, maxGasPercent),
  };
}

export class MaxYieldStrategy implements RebalanceStrategy {
  readonly name: StrategyName = 'MAX_YIELD';

  async analyze(params: StrategyParams): Promise<StrategyDecision> {
    const { currentProtocol, totalAmount, currentApy, availableProtocols, thresholds } = params;

    if (availableProtocols.length === 0) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: 'No protocols available for comparison',
      };
    }

    const bestProtocol = availableProtocols[0];

    if (bestProtocol.name === currentProtocol) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `Already on the highest-yielding protocol (${currentProtocol} at ${currentApy.toFixed(2)}%)`,
      };
    }

    const rawImprovement = bestProtocol.apy - currentApy;
    const costs = estimateRebalanceCosts(totalAmount, thresholds.maxGasPercent);
    const netImprovement = rawImprovement - costs.totalCostPercent;

    const shouldRebalance =
      netImprovement > thresholds.minimumImprovement &&
      costs.totalCostPercent < thresholds.maxGasPercent;

    if (shouldRebalance) {
      logger.info('MaxYieldStrategy: rebalance recommended', {
        from: currentProtocol,
        to: bestProtocol.name,
        currentApy,
        bestApy: bestProtocol.apy,
        rawImprovement: rawImprovement.toFixed(2),
        netImprovement: netImprovement.toFixed(2),
        gasCost: costs.gasFeePercent.toFixed(4),
        slippage: costs.slippagePercent.toFixed(4),
      });
    }

    return {
      shouldRebalance,
      targetProtocol: shouldRebalance ? bestProtocol.name : currentProtocol,
      reasoning: shouldRebalance
        ? `Moving from ${currentProtocol} (${currentApy.toFixed(2)}%) to ${bestProtocol.name} (${bestProtocol.apy.toFixed(2)}%) — net gain ${netImprovement.toFixed(2)}% after gas/slippage`
        : `Net improvement ${netImprovement.toFixed(2)}% below threshold ${thresholds.minimumImprovement}%`,
      deviationTrigger: shouldRebalance ? `APY delta: ${rawImprovement.toFixed(2)}%` : undefined,
      details: {
        currentApy,
        bestApy: bestProtocol.apy,
        bestProtocol: bestProtocol.name,
        rawImprovement,
        netImprovement,
        gasFeePercent: costs.gasFeePercent,
        slippagePercent: costs.slippagePercent,
        totalCostPercent: costs.totalCostPercent,
      },
    };
  }
}

export class TargetAllocationStrategy implements RebalanceStrategy {
  readonly name: StrategyName = 'TARGET_ALLOCATION';

  private readonly targetDeviationThreshold = 0.2;

  async analyze(params: StrategyParams): Promise<StrategyDecision> {
    const { currentProtocol, totalAmount, currentApy, availableProtocols, thresholds, userStrategyPreferences } = params;

    const relevantPrefs = userStrategyPreferences.filter(p => p.targetAllocations && Object.keys(p.targetAllocations!).length > 0);
    if (relevantPrefs.length === 0) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: 'No target allocations configured for these users',
      };
    }

    const pref = relevantPrefs[0];
    const targets = pref.targetAllocations!;
    const currentTarget = targets[currentProtocol];

    if (currentTarget === undefined) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `No target allocation set for ${currentProtocol}`,
      };
    }

    const totalTarget = Object.values(targets).reduce((sum, v) => sum + v, 0);
    const targetShare = totalTarget > 0 ? currentTarget / totalTarget : 0;

    const bestTargetProtocol = Object.entries(targets)
      .filter(([name]) => name !== currentProtocol)
      .sort(([, a], [, b]) => b - a);

    if (bestTargetProtocol.length === 0) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `Only one protocol configured in targets — no rebalance target available`,
      };
    }

    const [highestTargetProtocol, highestTarget] = bestTargetProtocol[0];
    const ratio = highestTarget > 0 ? currentTarget / highestTarget : 1;

    if (ratio < 1 - this.targetDeviationThreshold) {
      const costs = estimateRebalanceCosts(totalAmount, thresholds.maxGasPercent);

      if (costs.totalCostPercent >= thresholds.maxGasPercent || totalAmount === '0') {
        return {
          shouldRebalance: false,
          targetProtocol: currentProtocol,
          reasoning: `Rebalance from ${currentProtocol} to ${highestTargetProtocol} would exceed max gas cost`,
        };
      }

      logger.info('TargetAllocationStrategy: rebalance recommended', {
        from: currentProtocol,
        to: highestTargetProtocol,
        currentTarget: `${currentTarget}%`,
        highestTarget: `${highestTarget}%`,
        ratio: ratio.toFixed(2),
        gasCost: costs.gasFeePercent.toFixed(4),
        slippage: costs.slippagePercent.toFixed(4),
      });

      return {
        shouldRebalance: true,
        targetProtocol: highestTargetProtocol,
        reasoning: `Target allocation for ${currentProtocol} (${currentTarget}%) is significantly below ${highestTargetProtocol} (${highestTarget}%) — rebalancing to preferred protocol`,
        deviationTrigger: `Target ratio ${ratio.toFixed(2)} below threshold`,
        details: {
          currentProtocol,
          currentTarget,
          highestTargetProtocol,
          highestTarget,
          ratio,
          targets,
          totalCostPercent: costs.totalCostPercent,
        },
      };
    }

    return {
      shouldRebalance: false,
      targetProtocol: currentProtocol,
      reasoning: `Target allocation for ${currentProtocol} (${currentTarget}%) is within acceptable range of highest target ${highestTargetProtocol} (${highestTarget}%)`,
      details: {
        currentProtocol,
        currentTarget,
        highestTargetProtocol,
        highestTarget,
        ratio,
      },
    };
  }
}
