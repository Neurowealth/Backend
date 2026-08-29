/**
 * Yield composition: base vs incentive and the effective APY (#349) — pure code.
 *
 * A protocol's quoted APY can be split into a BASE rate (what the market pays
 * for the collateral itself) and an INCENTIVE rate (token-denominated rewards
 * paid on top). These are economically different — incentives can be diluted,
 * vest, or be pulled — so when a caller consumes yield it should value the
 * incentive part at a HAIRCUT rather than at face value.
 *
 * Zero I/O. The only non-pure helper here is `shouldUseEffectiveApy`, which is
 * a deliberate, testable boundary into the environment for the flag that gates
 * optimizer/agent consumption.
 */

/**
 * Fraction of the incentive component to discount (/haircut) when computing
 * effective APY — accounts for reward volatility, dilution and vesting risk.
 * 0.15 → incentives are valued at 85c on the dollar.
 */
export const INCENTIVE_HAIRCUT = 0.15

/**
 * The caveat that ships with every yield-breakdown response: base vs incentive
 * is parsed from the adapter's on-chain decomposition, and the effective APY is
 * a haircuted view — not a guaranteed return.
 */
export const YIELD_CAVEAT =
  'Yield is split into base (market) and incentive (token rewards) components. Effective APY values incentive rewards at a haircut because incentives can be diluted, vest, or be discontinued — it is not a guaranteed return.'

export interface YieldParts {
  baseApy?: number | null
  incentiveApy?: number | null
  /** Full quoted APY (supplyApy). Used as the fallback when no split exists. */
  supplyApy?: number | null
}

/**
 * Effective APY = base + incentive × (1 − INCENTIVE_HAIRCUT).
 *
 * Fallback hierarchy, and null-on-degenerate (never 0):
 *   - both parts known   → base + incentive×(1−haircut), floored at 0
 *   - only one part known → that part (no haircut isn't possible cleanly; use
 *                           the known part at face value)
 *   - only supplyApy      → supplyApy (no split → no haircut to apply)
 *   - nothing known       → null
 */
export function effectiveApy(input: YieldParts): number | null {
  const base = nullable(input.baseApy)
  const incentive = nullable(input.incentiveApy)
  const supply = nullable(input.supplyApy)

  if (base !== null && incentive !== null) {
    return Math.max(0, base + incentive * (1 - INCENTIVE_HAIRCUT))
  }
  if (base !== null) return Math.max(0, base)
  if (incentive !== null) return Math.max(0, incentive)
  if (supply !== null) return Math.max(0, supply)
  return null
}

/**
 * Share of total yield that comes from incentives, 0-1. Null when the split is
 * unknown or total is non-positive. Fail-safe: never rounds the incentive share
 * up; a large incentive share is a risk signal, surfaced for the risk scorer.
 */
export function incentiveShare(
  baseApy?: number | null,
  incentiveApy?: number | null
): number | null {
  const base = nullable(baseApy)
  const incentive = nullable(incentiveApy)
  if (base === null || incentive === null) return null
  const total = base + incentive
  if (total <= 0) return null
  return Math.max(0, Math.min(1, incentive / total))
}

/**
 * Whether optimizer/agent consumption should use effective (haircuted) yield
 * rather than the raw quoted APY. Gated by `USE_EFFECTIVE_APY=true`, default
 * OFF so existing behavior is byte-for-byte unchanged until the flag is set.
 */
export function shouldUseEffectiveApy(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.USE_EFFECTIVE_APY === 'true'
}

function nullable(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (!Number.isFinite(v)) return null
  return v
}
