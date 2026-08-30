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
  /**
   * Per-protocol exposure caps (#346). Pure data parsed from Json; validation
   * of values happens at the write-site validator (see
   * validateExposureCapConfig), this just coerces the shape safely.
   */
  exposureCaps?: Record<string, { maxFraction?: number; maxAbsolute?: string }>
  defaultMaxFraction?: number
}

export interface EffectiveStrategyConfig {
  strategyName: StrategyName | null
  targetAllocations?: Record<string, number>
  riskCeiling?: number
  exposureCaps?: Record<string, { maxFraction?: number; maxAbsolute?: string }>
  defaultMaxFraction?: number
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

  if (
    typeof raw.defaultMaxFraction === 'number' &&
    Number.isFinite(raw.defaultMaxFraction)
  ) {
    config.defaultMaxFraction = raw.defaultMaxFraction
  }

  if (
    typeof raw.exposureCaps === 'object' &&
    raw.exposureCaps !== null &&
    !Array.isArray(raw.exposureCaps)
  ) {
    const caps: NonNullable<StrategyConfigShape['exposureCaps']> = {}
    for (const [protocol, value] of Object.entries(
      raw.exposureCaps as Record<string, unknown>
    )) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue
      }
      const o = value as Record<string, unknown>
      const entry: { maxFraction?: number; maxAbsolute?: string } = {}
      if (typeof o.maxFraction === 'number' && Number.isFinite(o.maxFraction)) {
        entry.maxFraction = o.maxFraction
      }
      if (typeof o.maxAbsolute === 'string') {
        entry.maxAbsolute = o.maxAbsolute
      }
      caps[protocol] = entry
    }
    if (Object.keys(caps).length > 0) {
      config.exposureCaps = caps
    }
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
 * The stricter of two optional per-protocol exposure caps (#346). Lower fraction
 * is stricter (holds less in one protocol), so the tighter of the two wins —
 * a follow can only ever tighten a follower's concentration, mirroring the
 * risk-ceiling invariant.
 */
function stricterExposureCaps(
  own: StrategyConfigShape['exposureCaps'],
  followed: StrategyConfigShape['exposureCaps']
): StrategyConfigShape['exposureCaps'] {
  if (!followed) return own
  if (!own) return followed
  const out: NonNullable<StrategyConfigShape['exposureCaps']> = {}
  const protocols = new Set([...Object.keys(own), ...Object.keys(followed)])
  for (const p of protocols) {
    const a = own[p]?.maxFraction
    const b = followed[p]?.maxFraction
    const absA = own[p]?.maxAbsolute
    const absB = followed[p]?.maxAbsolute
    const entry: { maxFraction?: number; maxAbsolute?: string } = {}
    // Stricter fraction = lower; if only one side defines it, that one wins
    // only if the other is absent (a follow may tighten, not loosen).
    if (a !== undefined && b !== undefined) {
      entry.maxFraction = Math.min(a, b)
    } else if (a !== undefined) {
      entry.maxFraction = a
    } else if (b !== undefined) {
      entry.maxFraction = b
    }
    // Absolute: the lower bound wins when both present.
    if (absA !== undefined && absB !== undefined) {
      entry.maxAbsolute = Number(absA) <= Number(absB) ? absA : absB
    } else if (absA !== undefined) {
      entry.maxAbsolute = absA
    } else if (absB !== undefined) {
      entry.maxAbsolute = absB
    }
    if (entry.maxFraction !== undefined || entry.maxAbsolute !== undefined) {
      out[p] = entry
    }
  }
  return out
}

/**
 * The stricter of two defaultMaxFraction values (#346). Lower caps more, so
 * the lower wins. Absent (undefined) means no default, losing to any present.
 */
function stricterDefaultMaxFraction(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/**
 * Merge a follower's own config with the config they follow.
 *
 * With no follow this is the identity on `own` (see the no-follow contract in
 * the header). With a follow, the published strategy replaces the strategy and
 * its allocations WHOLESALE rather than key-by-key: pairing the publisher's
 * strategy with the follower's leftover allocations would produce a
 * configuration neither party chose. `riskCeiling` is the deliberate exception
 * — it clamps to the stricter of the two. `exposureCaps`/`defaultMaxFraction`
 * (#346) follow the same tighten-only rule as `riskCeiling`.
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
      exposureCaps: own.exposureCaps,
      defaultMaxFraction: own.defaultMaxFraction,
    }
  }

  const followedHasStrategy = Boolean(followed.strategyName)

  return {
    strategyName: followed.strategyName ?? own.strategyName ?? null,
    targetAllocations: followedHasStrategy
      ? followed.targetAllocations
      : (followed.targetAllocations ?? own.targetAllocations),
    riskCeiling: stricterRiskCeiling(own.riskCeiling, followed.riskCeiling),
    exposureCaps: stricterExposureCaps(own.exposureCaps, followed.exposureCaps),
    defaultMaxFraction: stricterDefaultMaxFraction(
      own.defaultMaxFraction,
      followed.defaultMaxFraction
    ),
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

  const caps = config.exposureCaps
    ? Object.keys(config.exposureCaps)
        .sort()
        .map((k) => {
          const c = config.exposureCaps![k]
          return `${k}=${c.maxFraction ?? ''}/${c.maxAbsolute ?? ''}`
        })
        .join(',')
    : ''

  return JSON.stringify({
    strategyName: config.strategyName ?? null,
    targetAllocations: allocations,
    riskCeiling: config.riskCeiling ?? null,
    defaultMaxFraction: config.defaultMaxFraction ?? null,
    exposureCaps: caps,
  })
}

/** True when two configs differ in a way followers must be told about. */
export function isMaterialConfigChange(
  previous: StrategyConfigShape,
  next: StrategyConfigShape
): boolean {
  return normalizeStrategyConfig(previous) !== normalizeStrategyConfig(next)
}
