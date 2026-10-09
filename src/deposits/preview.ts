/**
 * Recurring Deposit Preview / Simulation (#311).
 *
 * A deterministic simulation of the next N runs under the plan's policy.
 * Explicitly labeled as simulation, not a guarantee.
 *
 * Uses current ProtocolRate data and the same non-compounding APY convention
 * as calculateApy so numbers are consistent with the rest of the product.
 *
 * ─── CORRECTNESS ─────────────────────────────────────────────────────────────
 *
 * The preview renders the policy's inputs (regime math, drawdown state,
 * allocation math) so the user can audit the adaptive logic before it
 * touches money. It is a WHAT-IF tool, not a forecast.
 */

import {
  computeContribution,
  computeDrawdownPercent,
  computeNextRunAfterSkip,
  cadenceToDays,
  type SmartDcaConfig,
  type ContributionDecision,
  type RegimeInput,
  type DrawdownInput,
} from './smartDcaPolicy'
import { addCadence } from '../utils/cadence'

export interface PreviewRun {
  /** Run number (1-based). */
  runNumber: number
  /** Scheduled date for this run. */
  scheduledDate: string // YYYY-MM-DD
  /** Baseline amount before adaptive scaling. */
  baselineAmount: number
  /** Final amount after scaling/drawdown/allocation. */
  appliedAmount: number
  /** Whether this run would be skipped due to drawdown. */
  wouldSkip: boolean
  /** Volatility regime for this run (ADAPTIVE only). */
  regime: string | null
  /** Scaling factor applied (ADAPTIVE only). */
  scaleFactor: number | null
  /** Drawdown percentage at time of this run. */
  drawdownPct: number
  /** Human-readable reasoning for this run's amount. */
  reasoning: string
  /** Allocation legs if multi-protocol. */
  allocationLegs: { protocol: string; weightPercent: number; amount: number }[]
}

export interface PreviewResult {
  /** Plan ID. */
  planId: string
  /** Number of runs simulated. */
  runsCount: number
  /** Total projected contribution across all simulated runs. */
  totalContribution: number
  /** Simulated runs. */
  runs: PreviewRun[]
  /** Model disclaimer — always present. */
  disclaimer: string
  /** Whether this is a simulation. */
  isSimulation: true
}

/**
 * Generate a deterministic preview of the next N runs for a recurring
 * deposit plan. The preview uses the plan's current configuration and
 * projects forward using the same cadence and policy logic.
 *
 * @param plan - The plan configuration (amount, cadence, policy, etc.).
 * @param baselineAmount - The plan's baseline amount.
 * @param regimeInput - Current regime data (trailing values). Null = insufficient history.
 * @param drawdownInput - Current drawdown state. Null = no drawdown data.
 * @param numRuns - Number of future runs to simulate (default 12).
 * @param startDate - Starting date for the simulation (default: now).
 * @returns Deterministic preview result with disclaimer.
 */
export function generatePreview(
  plan: {
    id: string
    policy: SmartDcaConfig['policy']
    catchUpMode: SmartDcaConfig['catchUpMode']
    pauseOnDrawdownPct: SmartDcaConfig['pauseOnDrawdownPct']
    doubleOnDrawdown: SmartDcaConfig['doubleOnDrawdown']
    accumulatedRuns: SmartDcaConfig['accumulatedRuns']
    consecutiveFailures: SmartDcaConfig['consecutiveFailures']
    allocationMap: SmartDcaConfig['allocationMap']
    cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
    amount: number
  },
  regimeInput: RegimeInput | null,
  drawdownInput: DrawdownInput | null,
  numRuns: number = 12,
  startDate: Date = new Date()
): PreviewResult {
  const cadenceDays = cadenceToDays(plan.cadence)
  const config: SmartDcaConfig = {
    policy: plan.policy,
    catchUpMode: plan.catchUpMode,
    pauseOnDrawdownPct: plan.pauseOnDrawdownPct,
    doubleOnDrawdown: plan.doubleOnDrawdown,
    accumulatedRuns: plan.accumulatedRuns,
    consecutiveFailures: plan.consecutiveFailures,
    allocationMap: plan.allocationMap,
  }

  const runs: PreviewRun[] = []
  let totalContribution = 0
  let currentNextRunAt = addCadence(plan.cadence, startDate)
  let currentAccumulated = plan.accumulatedRuns

  for (let i = 0; i < numRuns; i++) {
    // For the preview, we use the same regime/drawdown for each run
    // (a real implementation would update these each run, but the preview
    // uses current state as a reasonable approximation).
    const decision: ContributionDecision = computeContribution(
      { ...config, accumulatedRuns: currentAccumulated },
      plan.amount,
      regimeInput,
      drawdownInput,
      currentNextRunAt
    )

    const wouldSkip = decision.appliedAmount === 0 && decision.pausedOnDrawdown
    const drawdownPct = drawdownInput
      ? computeDrawdownPercent(
          drawdownInput.peakValue,
          drawdownInput.currentValue
        )
      : 0

    runs.push({
      runNumber: i + 1,
      scheduledDate: currentNextRunAt.toISOString().slice(0, 10),
      baselineAmount: plan.amount,
      appliedAmount: decision.appliedAmount,
      wouldSkip,
      regime: decision.regime,
      scaleFactor: decision.scaleFactor,
      drawdownPct,
      reasoning: decision.reasoning,
      allocationLegs: decision.allocationLegs,
    })

    totalContribution += decision.appliedAmount

    // Advance to next run
    if (wouldSkip) {
      const next = computeNextRunAfterSkip(
        plan.catchUpMode,
        currentNextRunAt,
        cadenceDays,
        currentAccumulated
      )
      currentNextRunAt = next.nextRunAt
      currentAccumulated = next.accumulatedRuns
    } else {
      currentNextRunAt = addCadence(plan.cadence, currentNextRunAt)
      // Reset accumulated after a successful run
      if (plan.catchUpMode === 'ACCUMULATE') {
        currentAccumulated = 0
      }
    }
  }

  return {
    planId: plan.id,
    runsCount: runs.length,
    totalContribution,
    runs,
    disclaimer:
      'This is a simulation of future deposits based on current plan settings and market data. ' +
      'Actual deposits may differ due to market conditions, balance availability, and protocol changes. ' +
      'This is not a guarantee of future performance.',
    isSimulation: true as const,
  }
}
