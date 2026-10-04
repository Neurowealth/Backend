/**
 * Lending configuration invariants (#532).
 *
 * The lending book's safety rests entirely on the ORDERING of three numbers:
 *
 *     maxLtv  <  liquidationTargetLtv  <  liquidationLtvThreshold
 *
 * Get any pair the wrong way round and the product is quietly unsafe rather
 * than broken: a target above the threshold means every "corrective" sale
 * immediately re-breaches it and the monitor liquidates the position to dust;
 * a cap above the threshold means the platform lends against collateral it has
 * already promised to sell. Neither throws at runtime, so nothing would tell
 * you until a user lost money.
 *
 * `validateLendingConfig` therefore runs the ordering check ONCE, at module
 * load, and aborts the process if it fails — the same fail-fast posture
 * src/config/env.ts takes for a missing credential. A lending book with
 * inverted thresholds must never start.
 *
 * Pure and side-effect-free apart from the single load-time assertion, so the
 * rules are directly unit-testable.
 */

export interface LendingConfigLike {
  maxLtv: number
  liquidationLtvThreshold: number
  liquidationTargetLtv: number
  maxUnderlyingThresholdFraction: number
  fallbackBorrowApy: number
  platformSpreadApy: number
  minCollateralValue: number
  minPrincipal: number
  maxPrincipal: number
  approvalThreshold: number
  maxCollateralFractionSold: number
}

/**
 * Every invariant the lending book depends on, as human-readable issues.
 * An empty array means the configuration is safe to trade on.
 */
export function lendingConfigIssues(cfg: LendingConfigLike): string[] {
  const issues: string[] = []
  // Fields that failed a structural check. Ordering violations involving one of
  // these would be nonsense (`NaN` is neither above nor below anything), so
  // they are skipped rather than reported as a cascade of derived complaints
  // about a value that is not a number.
  const invalid = new Set<string>()

  const fractions: Array<[string, number]> = [
    ['lending.maxLtv', cfg.maxLtv],
    ['lending.liquidationLtvThreshold', cfg.liquidationLtvThreshold],
    ['lending.liquidationTargetLtv', cfg.liquidationTargetLtv],
    [
      'lending.maxUnderlyingThresholdFraction',
      cfg.maxUnderlyingThresholdFraction,
    ],
    ['lending.maxCollateralFractionSold', cfg.maxCollateralFractionSold],
  ]
  for (const [name, value] of fractions) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      issues.push(`${name} must be a fraction in (0, 1] (got ${value})`)
      invalid.add(name)
    }
  }

  for (const [name, value] of [
    ['lending.fallbackBorrowApy', cfg.fallbackBorrowApy],
    ['lending.platformSpreadApy', cfg.platformSpreadApy],
    ['lending.minCollateralValue', cfg.minCollateralValue],
    ['lending.minPrincipal', cfg.minPrincipal],
    ['lending.maxPrincipal', cfg.maxPrincipal],
    ['lending.approvalThreshold', cfg.approvalThreshold],
  ] as Array<[string, number]>) {
    if (!Number.isFinite(value) || value < 0) {
      issues.push(`${name} must be a non-negative number (got ${value})`)
      invalid.add(name)
    }
  }

  const ordered = (...names: string[]) =>
    !names.some((name) => invalid.has(name))

  if (
    ordered('lending.maxLtv', 'lending.liquidationLtvThreshold') &&
    cfg.maxLtv >= cfg.liquidationLtvThreshold
  ) {
    issues.push(
      `lending.maxLtv (${cfg.maxLtv}) must be below lending.liquidationLtvThreshold (${cfg.liquidationLtvThreshold}) — otherwise a loan can be originated already on top of its own liquidation line`
    )
  }

  if (
    ordered(
      'lending.liquidationTargetLtv',
      'lending.liquidationLtvThreshold'
    ) &&
    cfg.liquidationTargetLtv >= cfg.liquidationLtvThreshold
  ) {
    issues.push(
      `lending.liquidationTargetLtv (${cfg.liquidationTargetLtv}) must be below lending.liquidationLtvThreshold (${cfg.liquidationLtvThreshold}) — otherwise a corrective sale would immediately re-breach the threshold`
    )
  }

  if (
    ordered('lending.maxUnderlyingThresholdFraction') &&
    cfg.maxUnderlyingThresholdFraction >= 1
  ) {
    issues.push(
      `lending.maxUnderlyingThresholdFraction (${cfg.maxUnderlyingThresholdFraction}) must be below 1 — the platform's liquidation line must sit inside the underlying protocol's, never level with it`
    )
  }

  if (
    ordered('lending.minPrincipal', 'lending.maxPrincipal') &&
    cfg.minPrincipal > cfg.maxPrincipal
  ) {
    issues.push(
      `lending.minPrincipal (${cfg.minPrincipal}) must not exceed lending.maxPrincipal (${cfg.maxPrincipal})`
    )
  }

  return issues
}

/**
 * Assert the lending configuration is safe, or throw with every violation
 * listed. Called once at module load from src/lending/config.ts.
 */
export function assertValidLendingConfig(cfg: LendingConfigLike): void {
  const issues = lendingConfigIssues(cfg)
  if (issues.length === 0) return
  throw new Error(
    `Unsafe lending configuration — refusing to start:\n  - ${issues.join('\n  - ')}`
  )
}
