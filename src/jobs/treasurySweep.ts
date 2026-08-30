/**
 * src/jobs/treasurySweep.ts
 *
 * Treasury sweep engine for hot/warm/cold account tiering.
 * Minimal implementation for #341.
 */

import { getResilientClient } from '../stellar/client'
import { logger } from '../utils/logger'

// ── Configuration ───────────────────────────────────────────────────────────────

const TREASURY_SWEEP_INTERVAL_MS = 300_000 // 5 minutes
const HYSTERESIS_FACTOR = 1.5 // targetHigh must be >= targetLow * 1.5

// ── Types ───────────────────────────────────────────────────────────────────────

export interface SweepPlan {
  fromTier: string
  toTier: string
  asset: string
  amount: string
  reason: string
}

// ── Balance Evaluation ───────────────────────────────────────────────────────────

export async function evaluateTreasuryBalances(): Promise<SweepPlan[]> {
  const plans: SweepPlan[] = []

  // Minimal implementation - would read from TreasuryAccount table
  logger.info('[TreasurySweep] Evaluating treasury balances')

  // Example: Check if HOT tier needs to sweep to WARM
  // This would be expanded to read actual balances and compare to bands

  return plans
}

// ── Sweep Execution ─────────────────────────────────────────────────────────────

export async function executeSweep(plan: SweepPlan): Promise<void> {
  logger.info(`[TreasurySweep] Executing sweep: ${JSON.stringify(plan)}`)

  // Minimal implementation - would create OutboxOp for TREASURY_SWEEP
  // and let the existing dispatcher handle it
}

// ── Hysteresis Validation ───────────────────────────────────────────────────────

export function validateHysteresis(
  targetLow: number,
  targetHigh: number
): boolean {
  return targetHigh >= targetLow * HYSTERESIS_FACTOR
}

// ── Exported Configuration ─────────────────────────────────────────────────────

export const TREASURY_SWEEP_CONFIG = {
  INTERVAL_MS: TREASURY_SWEEP_INTERVAL_MS,
  HYSTERESIS_FACTOR,
}
