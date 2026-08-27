/**
 * Own-vs-followed strategy config resolution — pure computation (#285).
 *
 * The agent loop reads exactly three keys off a user's strategy config:
 * `strategyName`, `targetAllocations`, `riskCeiling` (see loop.ts). When that
 * user follows a published strategy, this module decides which of the two
 * configs each key comes from. Zero I/O so the precedence rules — the part that
 * actually changes what the agent does with someone's money — are unit testable
 * in isolation.
 *
 * Precedence, highest first (docs/STRATEGY_MARKETPLACE.md):
 *
 *   1. An ACTIVE SavingsGoal. Handled upstream in router.ts, not here — a
 *      stated personal target outranks a copied configuration, so a goal wins
 *      over a follow the same way it already wins over a stored preference.
 *   2. The followed strategy's config.
 *   3. The user's own User.rebalanceStrategy / User.strategyConfig.
 *
 * ─── THE RISK-CEILING INVARIANT ──────────────────────────────────────────────
 *
 * `riskCeiling` is the one key a follow may NOT simply overwrite. Higher score
 * = lower risk, so the stricter of the two ceilings is the MAXIMUM, and that is
 * what wins. A follow can only ever tighten a follower's risk exposure, never
 * widen it. Copying a stranger's looser ceiling onto someone's funds because
 * they clicked "follow" is not a trade-off this feature is allowed to make.
 * Mirrors the fail-closed contract in applyRiskCeiling (strategies.ts).
 *
 * ─── THE NO-FOLLOW CONTRACT ──────────────────────────────────────────────────
 *
 * With no follow, the returned config is the caller's own values unchanged —
 * the agent must take an identical code path and reach an identical decision
 * for the overwhelming majority of users who never touch this feature. A
 * regression test in tests/integration/agent/strategy-follow.integration.test.ts
 * asserts exactly that.
 */

import { StrategyName } from './types'

/** The three-key shape stored in User.strategyConfig / PublishedStrategy.strategyConfig. */
export interface StrategyConfigShape {
  strategyName?: StrategyName | null
  targetAllocations?: Record<string, number>
  riskCeiling?: number
}

export interface EffectiveStrategyConfig {
  strategyName: StrategyName | null
  targetAllocations?: Record<string, number>
  riskCeiling?: number
}

const KNOWN_STRATEGY_NAMES: readonly StrategyName[] = [
  'MAX_YIELD',
  'TARGET_ALLOCATION',
  'GOAL_TRACKING',
]

export function isKnownStrategyName(value: unknown): value is StrategyName {
  return (
    typeof value === 'string' &&
    (KNOWN_STRATEGY_NAMES as readonly string[]).includes(value)
  )
}

/**
 * Coerce an untrusted `Json` column into the three-key shape, dropping anything
 * unrecognized.
 *
 * Defensive on purpose: `strategyConfig` is a Prisma `Json` column with no
 * database-level shape guarantee, and `appliedConfig` is a snapshot that may
 * have been written by an older version of this code. Unknown strategy names
 * become null (falling through to MAX_YIELD in router.ts) rather than being
 * passed through to a strategy lookup that would silently mis-dispatch.
 */
export function parseStrategyConfig(value: unknown): StrategyConfigShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  const raw = value as Record<string, unknown>
  const config: StrategyConfigShape = {}

  if (isKnownStrategyName(raw.strategyName)) {
    config.strategyName = raw.strategyName
  }

  if (
    typeof raw.targetAllocations === 'object' &&
    raw.targetAllocations !== null &&
    !Array.isArray(raw.targetAllocations)
  ) {
    const allocations: Record<string, number> = {}
    for (const [protocol, weight] of Object.entries(
      raw.targetAllocations as Record<string, unknown>
    )) {
      if (typeof weight === 'number' && Number.isFinite(weight)) {
        allocations[protocol] = weight
      }
    }
    if (Object.keys(allocations).length > 0) {
      config.targetAllocations = allocations
    }
  }

  if (typeof raw.riskCeiling === 'number' && Number.isFinite(raw.riskCeiling)) {
    config.riskCeiling = raw.riskCeiling
  }

  return config
}

/**
 * The stricter of two optional risk ceilings. Higher score = lower risk, so
 * stricter is the larger number. Absent means "no ceiling", which is the
 * loosest possible setting and therefore loses to any present ceiling.
 */
export function stricterRiskCeiling(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

/**
 * Merge a follower's own config with the config they follow.
 *
 * With no follow this is the identity on `own` (see the no-follow contract in
 * the header). With a follow, the published strategy replaces the strategy and
 * its allocations WHOLESALE rather than key-by-key: pairing the publisher's
 * strategy with the follower's leftover allocations would produce a
 * configuration neither party chose. `riskCeiling` is the deliberate exception
 * — it clamps to the stricter of the two.
 */
export function resolveEffectiveConfig(
  own: StrategyConfigShape,
  followed?: StrategyConfigShape | null
): EffectiveStrategyConfig {
  if (!followed) {
    return {
      strategyName: own.strategyName ?? null,
      targetAllocations: own.targetAllocations,
      riskCeiling: own.riskCeiling,
    }
  }

  const followedHasStrategy = Boolean(followed.strategyName)

  return {
    strategyName: followed.strategyName ?? own.strategyName ?? null,
    targetAllocations: followedHasStrategy
      ? followed.targetAllocations
      : (followed.targetAllocations ?? own.targetAllocations),
    riskCeiling: stricterRiskCeiling(own.riskCeiling, followed.riskCeiling),
  }
}

/**
 * Canonical form used to decide whether a re-publish is a MATERIAL change.
 *
 * Only the three keys the agent actually acts on are compared — `label` is
 * cosmetic, and bumping `configVersion` for a typo fix would spam every
 * follower with a WhatsApp message and a webhook. Allocation keys are sorted so
 * that re-serializing the same object in a different key order is not mistaken
 * for a change.
 */
export function normalizeStrategyConfig(config: StrategyConfigShape): string {
  const allocations = config.targetAllocations
    ? Object.keys(config.targetAllocations)
        .sort()
        .map((k) => `${k}=${config.targetAllocations![k]}`)
        .join(',')
    : ''

  return JSON.stringify({
    strategyName: config.strategyName ?? null,
    targetAllocations: allocations,
    riskCeiling: config.riskCeiling ?? null,
  })
}

/** True when two configs differ in a way followers must be told about. */
export function isMaterialConfigChange(
  previous: StrategyConfigShape,
  next: StrategyConfigShape
): boolean {
  return normalizeStrategyConfig(previous) !== normalizeStrategyConfig(next)
}
