/**
 * src/agent/breakerState.ts
 *
 * Pure state machine for the agent circuit breaker (#345).
 *
 *   CLOSED --trip--> OPEN --(cooldown elapsed + sustained clean)--> HALF_OPEN
 *   HALF_OPEN --clean--> CLOSED
 *   HALF_OPEN --trip--> OPEN (cooldown doubles, capped)
 *
 * Machine state that must survive restarts (current cooldown, consecutive
 * clean evaluations) is kept under the reserved `detail._machine` key so the
 * schema's `detail` JSONB column carries it alongside the trip measurements.
 * Nothing here touches the DB or the clock — `now` is always passed in.
 */

import type { BreakerTripReason, RuleResult } from './breakerRules'

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'
export type BreakerScope = 'GLOBAL' | 'PROTOCOL' | 'USER'

export const BREAKER_SCOPES: readonly BreakerScope[] = [
  'GLOBAL',
  'PROTOCOL',
  'USER',
]

export interface BreakerTransitionConfig {
  /** Base cooldown (ms) before an OPEN breaker may auto-reset. */
  cooldownMs: number
  /** Hard cap (ms) on cooldown after repeated re-tripping. */
  maxCooldownMs: number
  /** Consecutive clean evaluations required before OPEN -> HALF_OPEN. */
  sustainedClearChecks: number
}

export interface BreakerRecord {
  state: BreakerState
  trippedRule: BreakerTripReason | null
  detail: Record<string, any> | null
  trippedAt: Date | null
  autoResetAt: Date | null
}

export interface MachineState {
  /** Consecutive clean evaluations since the last trip. */
  clearCount: number
  /** Current cooldown (ms) applicable to the OPEN state. */
  cooldownMs: number
}

const MACHINE_KEY = '_machine'

function readMachine(detail: Record<string, any> | null): MachineState {
  const m = detail?.[MACHINE_KEY]
  if (!m || typeof m !== 'object') {
    return { clearCount: 0, cooldownMs: 0 }
  }
  return {
    clearCount:
      typeof m.clearCount === 'number' && m.clearCount >= 0 ? m.clearCount : 0,
    cooldownMs:
      typeof m.cooldownMs === 'number' && m.cooldownMs > 0 ? m.cooldownMs : 0,
  }
}

function writeMachine(
  detail: Record<string, any> | null,
  machine: MachineState
): Record<string, any> {
  return { ...(detail ?? {}), [MACHINE_KEY]: machine }
}

/**
 * Apply a rule evaluation outcome to the current breaker record and return the
 * resulting record (pure). Only transitions; does not emit alerts/events.
 */
export function applyBreakerEvaluation(
  current: BreakerRecord,
  outcome: RuleResult,
  now: Date,
  config: BreakerTransitionConfig
): BreakerRecord {
  return outcome.tripped
    ? handleTrip(current, outcome, now, config)
    : handleClean(current, now, config)
}

function handleTrip(
  current: BreakerRecord,
  outcome: RuleResult,
  now: Date,
  config: BreakerTransitionConfig
): BreakerRecord {
  const machine = readMachine(current.detail)

  if (current.state === 'OPEN') {
    // Already open; stay open, record the failed evaluation. autoResetAt was
    // set on the original trip and governs the earliest recovery attempt.
    return {
      ...current,
      detail: {
        ...(current.detail ?? {}),
        lastEvaluation: {
          rule: outcome.rule,
          detail: outcome.detail,
          at: now.toISOString(),
        },
      },
    }
  }

  if (current.state === 'HALF_OPEN') {
    // Probe failed: back to OPEN with doubled cooldown (floored at the base).
    const nextCooldown = Math.min(
      Math.max(machine.cooldownMs || config.cooldownMs, config.cooldownMs) * 2,
      config.maxCooldownMs
    )
    return toOpen(current, outcome, now, nextCooldown)
  }

  // CLOSED -> OPEN with the base cooldown.
  return toOpen(current, outcome, now, config.cooldownMs)
}

function toOpen(
  current: BreakerRecord,
  outcome: RuleResult,
  now: Date,
  cooldownMs: number
): BreakerRecord {
  return {
    state: 'OPEN',
    trippedRule: outcome.rule,
    trippedAt: now,
    autoResetAt: new Date(now.getTime() + cooldownMs),
    detail: writeMachine(
      {
        rule: outcome.rule,
        detail: outcome.detail,
        at: now.toISOString(),
      },
      { clearCount: 0, cooldownMs }
    ),
  }
}

function handleClean(
  current: BreakerRecord,
  now: Date,
  config: BreakerTransitionConfig
): BreakerRecord {
  const machine = readMachine(current.detail)
  const clearCount = machine.clearCount + 1

  if (current.state === 'OPEN') {
    const cooldownReady =
      current.autoResetAt !== null && now >= current.autoResetAt
    const sustained = clearCount >= config.sustainedClearChecks
    if (cooldownReady && sustained) {
      return {
        ...current,
        state: 'HALF_OPEN',
        detail: writeMachine(current.detail, { ...machine, clearCount }),
      }
    }
    return {
      ...current,
      detail: writeMachine(current.detail, { ...machine, clearCount }),
    }
  }

  if (current.state === 'HALF_OPEN') {
    // One clean full evaluation cycle in HALF_OPEN closes the breaker.
    return {
      state: 'CLOSED',
      trippedRule: null,
      trippedAt: null,
      autoResetAt: null,
      detail: writeMachine(current.detail, {
        clearCount: 0,
        cooldownMs: config.cooldownMs,
      }),
    }
  }

  // CLOSED stays CLOSED.
  return current
}

/**
 * Manual trip: any state -> OPEN with rule 'manual'. Always audited by the
 * caller. If the breaker is already OPEN manual, returns it unchanged.
 */
export function applyManualTrip(
  current: BreakerRecord,
  now: Date,
  config: BreakerTransitionConfig
): BreakerRecord {
  if (current.state === 'OPEN' && current.trippedRule === 'manual') {
    return current
  }
  return {
    state: 'OPEN',
    trippedRule: 'manual',
    trippedAt: now,
    autoResetAt: new Date(now.getTime() + config.cooldownMs),
    detail: writeMachine(
      { rule: 'manual', at: now.toISOString() },
      { clearCount: 0, cooldownMs: config.cooldownMs }
    ),
  }
}

/**
 * Manual reset: any state -> CLOSED. Clears the trip and the machine state so
 * the next automatic evaluation starts clean. Carries the admin identity plus
 * the mandatory audit `reason` (recorded under detail._lastReset).
 */
export function applyManualReset(
  current: BreakerRecord,
  now: Date,
  resetBy: string,
  reason: string
): BreakerRecord {
  return {
    state: 'CLOSED',
    trippedRule: null,
    trippedAt: null,
    autoResetAt: null,
    detail: {
      ...(current.detail ?? {}),
      _lastReset: {
        resetBy,
        reason,
        at: now.toISOString(),
      },
    },
  }
}

/** Readable summary for admin inspect + getAgentStatus surfaces. */
export function describeBreaker(record: BreakerRecord): {
  state: string
  trippedRule: BreakerTripReason | null
  trippedAt: string | null
  autoResetAt: string | null
  cooldownMs: number
  clearCount: number
} {
  const m = readMachine(record.detail)
  return {
    state: record.state,
    trippedRule: record.trippedRule,
    trippedAt: record.trippedAt?.toISOString() ?? null,
    autoResetAt: record.autoResetAt?.toISOString() ?? null,
    cooldownMs: m.cooldownMs,
    clearCount: m.clearCount,
  }
}
