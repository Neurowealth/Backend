import {
  RebalanceStrategy,
  StrategyName,
  StrategyDecision,
  StrategyParams,
  YieldProtocol,
} from './types'
import { logger } from '../utils/logger'

/**
 * Reasoning emitted when a configured risk ceiling excludes every candidate
 * protocol. This is an explicit, surfaced state — the ceiling is NEVER silently
 * dropped to keep the agent allocating (see issue #291 acceptance criteria and
 * the test that guards this in tests/unit/agent/strategies.test.ts).
 */
export const NO_ELIGIBLE_PROTOCOLS_REASON =
  'No protocols currently meet your risk tolerance'

/**
 * Apply an optional risk ceiling to a candidate protocol set.
 *
 * Backward-compatibility contract: when `riskCeiling` is undefined this returns
 * the SAME array reference unchanged, so a user who never sets a ceiling sees
 * byte-for-byte identical behavior to before this parameter existed.
 *
 * Fail-closed: when a ceiling IS set, a protocol with no known score is treated
 * as ineligible rather than given the benefit of the doubt — a risk control must
 * not admit unknowns.
 */
export function applyRiskCeiling(
  protocols: YieldProtocol[],
  riskCeiling: number | undefined,
  scores: Record<string, number> | undefined
): YieldProtocol[] {
  if (riskCeiling === undefined) return protocols
  const scoreMap = scores ?? {}
  return protocols.filter((p) => {
    const score = scoreMap[p.name]
    return score !== undefined && score >= riskCeiling
  })
}

function estimateRebalanceCosts(
  amount: string,
  maxGasPercent: number
): {
  gasFeePercent: number
  slippagePercent: number
  totalCostPercent: number
} {
  const gasEstimateUSD = 0.5
  const amountUSD = parseInt(amount) / 1e18
  const gasFeePercent = amountUSD > 0 ? (gasEstimateUSD / amountUSD) * 100 : 0
  const slippagePercent = Math.min(maxGasPercent * 0.5, 0.25)

  return {
    gasFeePercent: Math.min(gasFeePercent, maxGasPercent),
    slippagePercent,
    totalCostPercent: Math.min(gasFeePercent + slippagePercent, maxGasPercent),
  }
}

export class MaxYieldStrategy implements RebalanceStrategy {
  readonly name: StrategyName = 'MAX_YIELD'

  async analyze(params: StrategyParams): Promise<StrategyDecision> {
    const {
      currentProtocol,
      totalAmount,
      currentApy,
      availableProtocols,
      thresholds,
      riskCeiling,
      protocolRiskScores,
    } = params

    if (availableProtocols.length === 0) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: 'No protocols available for comparison',
      }
    }

    // Enforce the risk ceiling BEFORE optimizing for yield. When no ceiling is
    // set this is a no-op that preserves the original candidate set exactly.
    const eligibleProtocols = applyRiskCeiling(
      availableProtocols,
      riskCeiling,
      protocolRiskScores
    )

    if (riskCeiling !== undefined && eligibleProtocols.length === 0) {
      logger.info('MaxYieldStrategy: no protocols meet risk ceiling', {
        riskCeiling,
        candidates: availableProtocols.map((p) => p.name),
      })
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: NO_ELIGIBLE_PROTOCOLS_REASON,
        details: { riskCeiling, eligibleCount: 0 },
      }
    }

    const bestProtocol = eligibleProtocols[0]

    if (bestProtocol.name === currentProtocol) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `Already on the highest-yielding protocol (${currentProtocol} at ${currentApy.toFixed(2)}%)`,
      }
    }

    const rawImprovement = bestProtocol.apy - currentApy
    const costs = estimateRebalanceCosts(totalAmount, thresholds.maxGasPercent)
    const netImprovement = rawImprovement - costs.totalCostPercent

    const shouldRebalance =
      netImprovement > thresholds.minimumImprovement &&
      costs.totalCostPercent < thresholds.maxGasPercent

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
      })
    }

    return {
      shouldRebalance,
      targetProtocol: shouldRebalance ? bestProtocol.name : currentProtocol,
      reasoning: shouldRebalance
        ? `Moving from ${currentProtocol} (${currentApy.toFixed(2)}%) to ${bestProtocol.name} (${bestProtocol.apy.toFixed(2)}%) — net gain ${netImprovement.toFixed(2)}% after gas/slippage`
        : `Net improvement ${netImprovement.toFixed(2)}% below threshold ${thresholds.minimumImprovement}%`,
      deviationTrigger: shouldRebalance
        ? `APY delta: ${rawImprovement.toFixed(2)}%`
        : undefined,
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
    }
  }
}

export class TargetAllocationStrategy implements RebalanceStrategy {
  readonly name: StrategyName = 'TARGET_ALLOCATION'

  private readonly targetDeviationThreshold = 0.2

  async analyze(params: StrategyParams): Promise<StrategyDecision> {
    const {
      currentProtocol,
      totalAmount,
      currentApy,
      availableProtocols,
      thresholds,
      userStrategyPreferences,
      riskCeiling,
      protocolRiskScores,
    } = params

    const relevantPrefs = userStrategyPreferences.filter(
      (p) => p.targetAllocations && Object.keys(p.targetAllocations!).length > 0
    )
    if (relevantPrefs.length === 0) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: 'No target allocations configured for these users',
      }
    }

    const pref = relevantPrefs[0]
    const targets = pref.targetAllocations!
    const currentTarget = targets[currentProtocol]

    if (currentTarget === undefined) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `No target allocation set for ${currentProtocol}`,
      }
    }

    const totalTarget = Object.values(targets).reduce((sum, v) => sum + v, 0)
    const targetShare = totalTarget > 0 ? currentTarget / totalTarget : 0

    // Candidate rebalance targets are the configured protocols other than the
    // current one. When a risk ceiling is set, exclude any candidate that does
    // not clear it (fail-closed on unknown scores) BEFORE choosing a target.
    // When no ceiling is set this filter is a no-op, preserving prior behavior.
    const scoreMap = protocolRiskScores ?? {}
    const passesCeiling = (name: string): boolean =>
      riskCeiling === undefined ||
      (scoreMap[name] !== undefined && scoreMap[name] >= riskCeiling)

    const bestTargetProtocol = Object.entries(targets)
      .filter(([name]) => name !== currentProtocol)
      .filter(([name]) => passesCeiling(name))
      .sort(([, a], [, b]) => b - a)

    if (bestTargetProtocol.length === 0) {
      // Distinguish "ceiling excluded everything" from "nothing else configured"
      // so the user's stated risk tolerance is surfaced, never silently dropped.
      if (riskCeiling !== undefined) {
        const otherConfigured = Object.keys(targets).filter(
          (name) => name !== currentProtocol
        )
        if (otherConfigured.length > 0) {
          logger.info(
            'TargetAllocationStrategy: no target protocols meet risk ceiling',
            {
              riskCeiling,
              candidates: otherConfigured,
            }
          )
          return {
            shouldRebalance: false,
            targetProtocol: currentProtocol,
            reasoning: NO_ELIGIBLE_PROTOCOLS_REASON,
            details: { riskCeiling, eligibleCount: 0 },
          }
        }
      }
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `Only one protocol configured in targets — no rebalance target available`,
      }
    }

    const [highestTargetProtocol, highestTarget] = bestTargetProtocol[0]
    const ratio = highestTarget > 0 ? currentTarget / highestTarget : 1

    if (ratio < 1 - this.targetDeviationThreshold) {
      const costs = estimateRebalanceCosts(
        totalAmount,
        thresholds.maxGasPercent
      )

      if (
        costs.totalCostPercent >= thresholds.maxGasPercent ||
        totalAmount === '0'
      ) {
        return {
          shouldRebalance: false,
          targetProtocol: currentProtocol,
          reasoning: `Rebalance from ${currentProtocol} to ${highestTargetProtocol} would exceed max gas cost`,
        }
      }

      logger.info('TargetAllocationStrategy: rebalance recommended', {
        from: currentProtocol,
        to: highestTargetProtocol,
        currentTarget: `${currentTarget}%`,
        highestTarget: `${highestTarget}%`,
        ratio: ratio.toFixed(2),
        gasCost: costs.gasFeePercent.toFixed(4),
        slippage: costs.slippagePercent.toFixed(4),
      })

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
      }
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
    }
  }
}

/**
 * Years remaining between now and a future target date. Mirrors the
 * non-compounding convention of calculateYearsActive in snapshotter.ts, but
 * for a future date rather than a past one. Zero or negative means the target
 * date has already passed.
 */
export function calculateYearsRemaining(
  targetDate: Date,
  from: Date = new Date()
): number {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000
  return (targetDate.getTime() - from.getTime()) / msPerYear
}

/**
 * Required simple annualized rate (as a percentage, e.g. 8.0 = 8%) to grow
 * startingAmount into targetAmount over yearsRemaining. Intentionally the same
 * simple-rate math as calculateApy in snapshotter.ts — this issue reuses that
 * convention for consistency with live APY reporting rather than introducing a
 * second, compounding-aware model (that work is tracked separately in #225).
 *
 * Returns Infinity when the target date has already passed and the goal is
 * not yet met (no finite rate can close the gap in zero or negative time).
 */
export function calculateRequiredApy(
  startingAmount: number,
  targetAmount: number,
  yearsRemaining: number
): number {
  if (targetAmount <= startingAmount) return 0
  if (yearsRemaining <= 0) return Infinity
  return (
    ((targetAmount - startingAmount) / startingAmount / yearsRemaining) * 100
  )
}

/**
 * Goal-tracking strategy (#281). Computes the simple annualized rate required
 * to hit a user's SavingsGoal by its target date, then delegates to
 * MaxYieldStrategy (bounded by riskCeiling) when behind schedule, or holds
 * position when already on track. It NEVER silently exceeds the configured
 * risk ceiling to chase an unrealistic goal — when the required rate exceeds
 * the best APY available among risk-eligible protocols, it surfaces that as an
 * explicit "unreachable" decision instead of overriding the ceiling.
 */
export class GoalTrackingStrategy implements RebalanceStrategy {
  readonly name: StrategyName = 'GOAL_TRACKING'

  async analyze(params: StrategyParams): Promise<StrategyDecision> {
    const {
      currentProtocol,
      currentApy,
      availableProtocols,
      goal,
      riskCeiling,
      protocolRiskScores,
    } = params

    if (!goal) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: 'No active savings goal configured',
      }
    }

    if (goal.targetAmount <= goal.startingAmount) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: 'Savings goal is already achieved',
        details: { goal },
      }
    }

    const yearsRemaining = calculateYearsRemaining(goal.targetDate)

    if (yearsRemaining <= 0) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: 'Savings goal target date has passed without being met',
        details: { goal },
      }
    }

    const requiredApy = calculateRequiredApy(
      goal.startingAmount,
      goal.targetAmount,
      yearsRemaining
    )

    const eligibleProtocols = applyRiskCeiling(
      availableProtocols,
      riskCeiling,
      protocolRiskScores
    )

    if (riskCeiling !== undefined && eligibleProtocols.length === 0) {
      logger.info('GoalTrackingStrategy: no protocols meet risk ceiling', {
        riskCeiling,
        requiredApy: requiredApy.toFixed(2),
      })
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: NO_ELIGIBLE_PROTOCOLS_REASON,
        details: { requiredApy, riskCeiling, eligibleCount: 0 },
      }
    }

    const candidateApys = eligibleProtocols.map((p) => p.apy)
    const maxEligibleApy =
      candidateApys.length > 0 ? Math.max(...candidateApys) : currentApy

    if (requiredApy > maxEligibleApy) {
      // Required rate is unreachable within the user's risk tolerance. Surface
      // this explicitly rather than quietly overriding the risk ceiling.
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `Target requires ${requiredApy.toFixed(2)}% APY, which exceeds the best available within your risk tolerance (${maxEligibleApy.toFixed(2)}%) — target not reachable within your risk tolerance`,
        details: {
          requiredApy,
          maxEligibleApy,
          riskCeiling,
          unreachable: true,
        },
      }
    }

    if (currentApy >= requiredApy) {
      return {
        shouldRebalance: false,
        targetProtocol: currentProtocol,
        reasoning: `On track — current ${currentApy.toFixed(2)}% APY meets the ${requiredApy.toFixed(2)}% required to reach your goal by ${goal.targetDate.toISOString().slice(0, 10)}`,
        details: { requiredApy, currentApy, onTrack: true },
      }
    }

    // Behind schedule and reachable: delegate to MaxYieldStrategy (already
    // bounded by the same riskCeiling) to chase the best eligible yield.
    const maxYield = new MaxYieldStrategy()
    const decision = await maxYield.analyze(params)

    return {
      ...decision,
      reasoning: `Behind schedule (need ${requiredApy.toFixed(2)}% APY to reach your goal) — ${decision.reasoning}`,
      details: { ...decision.details, requiredApy, goalDriven: true },
    }
  }
}
