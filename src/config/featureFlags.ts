/**
 * Central Feature Flag Management & Staged Rollout / Rollback System (#494)
 *
 * Provides a robust, environment-aware feature flag architecture supporting:
 * - Deterministic staged rollouts (0% -> 10% -> 25% -> 50% -> 100%) via cryptographic entity hashing
 * - Environment awareness (development, test, staging, production) with environment overrides
 * - Granular allowlists and blocklists
 * - Fast emergency rollback and kill switches with audit logging
 * - Distributed state synchronization via Redis (when available)
 * - Evaluation decision logging with structured Winston context & Prometheus metrics
 */

import crypto from 'node:crypto'
import { logger } from '../utils/logger'
import {
  recordFeatureFlagEvaluation,
  recordFeatureFlagRollback,
  setFeatureFlagRolloutGauge,
} from '../utils/metrics'
import { cacheGet, cacheSet, getRedisClient } from './redis'

export type Environment = 'development' | 'test' | 'staging' | 'production'

export type FlagEvaluationDecision =
  | 'GLOBAL_MAINTENANCE'
  | 'KILL_SWITCH'
  | 'EMERGENCY_ROLLBACK'
  | 'BLOCKLIST'
  | 'ALLOWLIST'
  | 'RUNTIME_OVERRIDE'
  | 'ENV_VAR_OVERRIDE'
  | 'PERCENTAGE_ROLLOUT_MATCH'
  | 'PERCENTAGE_ROLLOUT_MISMATCH'
  | 'ENVIRONMENT_DEFAULT'
  | 'DEFAULT_FALLBACK'

export interface FlagEvaluationContext {
  entityId?: string // Deterministic hash seed (e.g. userId, ip, walletAddress)
  environment?: Environment
  attributes?: Record<string, string | number | boolean>
}

export interface FlagEvaluationResult {
  flag: string
  enabled: boolean
  decision: FlagEvaluationDecision
  environment: Environment
  entityId?: string
  rolloutPercentage: number
  reason: string
  timestamp: string
}

export interface EnvironmentRule {
  enabled: boolean
  rolloutPercentage?: number // 0 to 100
  allowlist?: string[]
  blocklist?: string[]
}

export interface FeatureFlagDefinition {
  key: string
  description: string
  environments: Record<Environment, EnvironmentRule>
  allowlist?: string[]
  blocklist?: string[]
  killSwitch?: boolean
  rolledBack?: boolean
  rollbackReason?: string
  rollbackTimestamp?: string
  rollbackOperator?: string
}

export interface FeatureFlagOverride {
  enabled?: boolean
  rolloutPercentage?: number
  allowlist?: string[]
  blocklist?: string[]
  killSwitch?: boolean
  rolledBack?: boolean
  rollbackReason?: string
  updatedAt: string
  updatedBy?: string
}

export interface RollbackEvent {
  flagKey: string
  reason: string
  operator: string
  timestamp: string
  previousState: {
    enabled?: boolean
    rolloutPercentage?: number
  }
}

/**
 * Normalizes and resolves the current runtime environment.
 */
export function getCurrentEnvironment(): Environment {
  const env = (process.env.NODE_ENV || 'development').toLowerCase()
  if (env === 'production' || env === 'prod') return 'production'
  if (env === 'staging' || env === 'stage') return 'staging'
  if (env === 'test') return 'test'
  return 'development'
}

/**
 * Deterministically computes a percentile bucket (0-99) for a given entity and flag.
 * Uses SHA-256 to ensure uniform, monotonic distribution across pods and restarts.
 */
export function hashEntityToPercentage(
  flagKey: string,
  entityId: string
): number {
  if (!entityId || typeof entityId !== 'string') return 0
  const hash = crypto
    .createHash('sha256')
    .update(`${flagKey}:${entityId.trim()}`)
    .digest('hex')
  const intVal = parseInt(hash.substring(0, 8), 16)
  return intVal % 100
}

/**
 * Core catalog of built-in system feature flags.
 */
export const DEFAULT_FEATURE_FLAGS: Record<string, FeatureFlagDefinition> = {
  agent_autonomous_rebalance: {
    key: 'agent_autonomous_rebalance',
    description: 'Enables automatic agent-driven portfolio rebalancing',
    environments: {
      development: { enabled: true, rolloutPercentage: 100 },
      test: { enabled: true, rolloutPercentage: 100 },
      staging: { enabled: true, rolloutPercentage: 50 },
      production: { enabled: false, rolloutPercentage: 0 },
    },
  },
  smart_dca_engine: {
    key: 'smart_dca_engine',
    description: 'Volatility-aware adaptive recurring deposits engine',
    environments: {
      development: { enabled: true, rolloutPercentage: 100 },
      test: { enabled: true, rolloutPercentage: 100 },
      staging: { enabled: true, rolloutPercentage: 25 },
      production: { enabled: false, rolloutPercentage: 0 },
    },
  },
  enhanced_stellar_routing: {
    key: 'enhanced_stellar_routing',
    description: 'Horizon liquidity path finding and smart fee routing',
    environments: {
      development: { enabled: true, rolloutPercentage: 100 },
      test: { enabled: true, rolloutPercentage: 100 },
      staging: { enabled: true, rolloutPercentage: 100 },
      production: { enabled: true, rolloutPercentage: 10 },
    },
  },
  ai_assistant_tool_calling: {
    key: 'ai_assistant_tool_calling',
    description: 'Conversational assistant with autonomous tool invocation',
    environments: {
      development: { enabled: true, rolloutPercentage: 100 },
      test: { enabled: true, rolloutPercentage: 100 },
      staging: { enabled: true, rolloutPercentage: 50 },
      production: { enabled: false, rolloutPercentage: 0 },
    },
  },
  circuit_breaker_v2: {
    key: 'circuit_breaker_v2',
    description: 'Dynamic volatility and drawdown circuit breaker trip rules',
    environments: {
      development: { enabled: true, rolloutPercentage: 100 },
      test: { enabled: true, rolloutPercentage: 100 },
      staging: { enabled: true, rolloutPercentage: 100 },
      production: { enabled: true, rolloutPercentage: 100 },
    },
  },
  fast_fiat_onramp: {
    key: 'fast_fiat_onramp',
    description: 'Direct instant on-ramp quoting and locking',
    environments: {
      development: { enabled: true, rolloutPercentage: 100 },
      test: { enabled: true, rolloutPercentage: 100 },
      staging: { enabled: true, rolloutPercentage: 100 },
      production: { enabled: false, rolloutPercentage: 0 },
    },
  },
  emergency_maintenance_mode: {
    key: 'emergency_maintenance_mode',
    description:
      'Emergency kill-switch to halt state-mutating requests platform-wide',
    environments: {
      development: { enabled: false, rolloutPercentage: 0 },
      test: { enabled: false, rolloutPercentage: 0 },
      staging: { enabled: false, rolloutPercentage: 0 },
      production: { enabled: false, rolloutPercentage: 0 },
    },
  },
}

export type FeatureFlagKey =
  | keyof typeof DEFAULT_FEATURE_FLAGS
  | (string & {})

const REDIS_OVERRIDES_KEY = 'neurowealth:feature_flags:overrides'
const REDIS_UPDATES_CHANNEL = 'neurowealth:feature_flags:updates'

/**
 * FeatureFlagManager: central orchestrator for evaluating, overriding,
 * rolling out, and rolling back feature flags.
 */
export class FeatureFlagManager {
  private flags: Map<string, FeatureFlagDefinition> = new Map()
  private overrides: Map<string, FeatureFlagOverride> = new Map()
  private rollbackHistory: RollbackEvent[] = []
  private redisSyncSubscribed = false

  constructor(initialFlags: Record<string, FeatureFlagDefinition> = DEFAULT_FEATURE_FLAGS) {
    for (const [key, def] of Object.entries(initialFlags)) {
      this.flags.set(key, { ...def })
    }
  }

  /**
   * Register a custom feature flag definition into the manager.
   */
  public registerFlag(flag: FeatureFlagDefinition): void {
    this.flags.set(flag.key, { ...flag })
    logger.info(`[FeatureFlag] Registered flag "${flag.key}"`, {
      flagKey: flag.key,
      description: flag.description,
    })
  }

  /**
   * Retrieve a feature flag definition by key.
   */
  public getFlag(flagKey: string): FeatureFlagDefinition | undefined {
    return this.flags.get(flagKey)
  }

  /**
   * Evaluates a feature flag against the current environment and evaluation context.
   * Logs every evaluation decision with structured metadata.
   */
  public evaluate(
    flagKey: string,
    contextOrEntityId?: FlagEvaluationContext | string
  ): FlagEvaluationResult {
    const context: FlagEvaluationContext | undefined =
      typeof contextOrEntityId === 'string'
        ? { entityId: contextOrEntityId }
        : contextOrEntityId

    const env = context?.environment || getCurrentEnvironment()
    const entityId = context?.entityId
    const now = new Date().toISOString()
    const def = this.flags.get(flagKey)

    // Helper to log decision, update metrics, and return structured result
    const makeDecision = (
      enabled: boolean,
      decision: FlagEvaluationDecision,
      reason: string,
      rolloutPct: number = enabled ? 100 : 0
    ): FlagEvaluationResult => {
      const result: FlagEvaluationResult = {
        flag: flagKey,
        enabled,
        decision,
        environment: env,
        entityId,
        rolloutPercentage: rolloutPct,
        reason,
        timestamp: now,
      }

      // Acceptance criterion: Logging captures flag evaluation decisions
      logger.info(
        `[FeatureFlag] Evaluated flag "${flagKey}": ${enabled ? 'ENABLED' : 'DISABLED'} (${decision})`,
        {
          event: 'feature_flag_evaluation',
          flag: flagKey,
          enabled,
          decision,
          reason,
          environment: env,
          entityId: entityId || null,
          rolloutPercentage: rolloutPct,
        }
      )

      recordFeatureFlagEvaluation(flagKey, decision, enabled)
      setFeatureFlagRolloutGauge(flagKey, rolloutPct)

      return result
    }

    // ── 1. Global Maintenance Kill Switch ─────────────────────────────────────
    if (flagKey !== 'emergency_maintenance_mode') {
      const globalMaintenance = this.evaluate('emergency_maintenance_mode', {
        environment: env,
      })
      if (globalMaintenance.enabled) {
        return makeDecision(
          false,
          'GLOBAL_MAINTENANCE',
          'Global emergency maintenance mode is active',
          0
        )
      }
    }

    // ── 2. Flag-specific Kill Switch ─────────────────────────────────────────
    if (def?.killSwitch) {
      return makeDecision(
        false,
        'KILL_SWITCH',
        'Flag-level kill switch is actively engaged',
        0
      )
    }

    // ── 3. Emergency Rollback Check ───────────────────────────────────────────
    if (def?.rolledBack) {
      return makeDecision(
        false,
        'EMERGENCY_ROLLBACK',
        `Flag rolled back: ${def.rollbackReason || 'Emergency rollback triggered'}`,
        0
      )
    }

    // Check emergency rollback environment variable: FEATURE_FLAGS_ROLLBACK
    const rollbackEnv = process.env.FEATURE_FLAGS_ROLLBACK
    if (rollbackEnv) {
      const rolledBackList = rollbackEnv
        .split(',')
        .map((s) => s.trim().toLowerCase())
      if (rolledBackList.includes(flagKey.toLowerCase())) {
        return makeDecision(
          false,
          'EMERGENCY_ROLLBACK',
          'Flag disabled via FEATURE_FLAGS_ROLLBACK environment variable',
          0
        )
      }
    }

    // ── 4. Entity Blocklist Check ─────────────────────────────────────────────
    if (entityId && def?.blocklist && def.blocklist.includes(entityId)) {
      return makeDecision(
        false,
        'BLOCKLIST',
        `Entity "${entityId}" is explicitly on the blocklist`,
        0
      )
    }

    const envRule = def?.environments[env]
    if (entityId && envRule?.blocklist && envRule.blocklist.includes(entityId)) {
      return makeDecision(
        false,
        'BLOCKLIST',
        `Entity "${entityId}" is on the environment blocklist`,
        0
      )
    }

    // ── 5. Entity Allowlist Check ─────────────────────────────────────────────
    if (entityId && def?.allowlist && def.allowlist.includes(entityId)) {
      return makeDecision(
        true,
        'ALLOWLIST',
        `Entity "${entityId}" is explicitly on the global allowlist`,
        100
      )
    }

    if (entityId && envRule?.allowlist && envRule.allowlist.includes(entityId)) {
      return makeDecision(
        true,
        'ALLOWLIST',
        `Entity "${entityId}" is on the environment allowlist`,
        100
      )
    }

    // ── 6. Runtime Overrides (e.g. from Admin API or Redis) ───────────────────
    const override = this.overrides.get(flagKey)
    if (override) {
      if (override.killSwitch || override.rolledBack) {
        return makeDecision(
          false,
          override.rolledBack ? 'EMERGENCY_ROLLBACK' : 'KILL_SWITCH',
          override.rollbackReason || 'Runtime override kill switch engaged',
          0
        )
      }

      if (override.allowlist && entityId && override.allowlist.includes(entityId)) {
        return makeDecision(
          true,
          'ALLOWLIST',
          `Entity "${entityId}" is on the runtime override allowlist`,
          100
        )
      }

      if (override.blocklist && entityId && override.blocklist.includes(entityId)) {
        return makeDecision(
          false,
          'BLOCKLIST',
          `Entity "${entityId}" is on the runtime override blocklist`,
          0
        )
      }

      if (override.rolloutPercentage !== undefined) {
        const pct = Math.max(0, Math.min(100, override.rolloutPercentage))
        if (entityId) {
          const bucket = hashEntityToPercentage(flagKey, entityId)
          const matched = bucket < pct
          return makeDecision(
            matched,
            matched
              ? 'PERCENTAGE_ROLLOUT_MATCH'
              : 'PERCENTAGE_ROLLOUT_MISMATCH',
            `Runtime staged rollout (${pct}%) for entity bucket ${bucket}`,
            pct
          )
        }
        return makeDecision(
          pct > 0,
          'RUNTIME_OVERRIDE',
          `Runtime override staged rollout at ${pct}%`,
          pct
        )
      }

      if (override.enabled !== undefined) {
        return makeDecision(
          override.enabled,
          'RUNTIME_OVERRIDE',
          `Runtime override explicitly set to ${override.enabled}`,
          override.enabled ? 100 : 0
        )
      }
    }

    // ── 7. Environment Variable Overrides ─────────────────────────────────────
    const envVarKey = `FEATURE_FLAG_${flagKey.toUpperCase()}`
    const envKillSwitch = process.env[`${envVarKey}_KILL_SWITCH`]
    if (envKillSwitch && envKillSwitch.toLowerCase() === 'true') {
      return makeDecision(
        false,
        'KILL_SWITCH',
        `Kill switch engaged via ${envVarKey}_KILL_SWITCH`,
        0
      )
    }

    const envPctStr = process.env[`${envVarKey}_PERCENTAGE`]
    if (envPctStr !== undefined && !isNaN(Number(envPctStr))) {
      const pct = Math.max(0, Math.min(100, Number(envPctStr)))
      if (entityId) {
        const bucket = hashEntityToPercentage(flagKey, entityId)
        const matched = bucket < pct
        return makeDecision(
          matched,
          matched ? 'PERCENTAGE_ROLLOUT_MATCH' : 'PERCENTAGE_ROLLOUT_MISMATCH',
          `Env var ${envVarKey}_PERCENTAGE (${pct}%) evaluated entity bucket ${bucket}`,
          pct
        )
      }
      return makeDecision(
        pct > 0,
        'ENV_VAR_OVERRIDE',
        `Env var ${envVarKey}_PERCENTAGE set to ${pct}%`,
        pct
      )
    }

    const envVal = process.env[envVarKey]
    if (envVal !== undefined) {
      const parsedBool = envVal.toLowerCase() === 'true' || envVal === '1'
      return makeDecision(
        parsedBool,
        'ENV_VAR_OVERRIDE',
        `Env var ${envVarKey} explicitly set to ${parsedBool}`,
        parsedBool ? 100 : 0
      )
    }

    // ── 8. Environment-Aware Configuration ───────────────────────────────────
    if (envRule) {
      const pct =
        envRule.rolloutPercentage !== undefined
          ? Math.max(0, Math.min(100, envRule.rolloutPercentage))
          : envRule.enabled
            ? 100
            : 0

      // If entityId is supplied and rolloutPercentage is partial (1-99%)
      if (entityId && pct > 0 && pct < 100) {
        const bucket = hashEntityToPercentage(flagKey, entityId)
        const matched = bucket < pct
        return makeDecision(
          matched,
          matched ? 'PERCENTAGE_ROLLOUT_MATCH' : 'PERCENTAGE_ROLLOUT_MISMATCH',
          `Environment "${env}" staged rollout (${pct}%) evaluated entity bucket ${bucket}`,
          pct
        )
      }

      // If rolloutPercentage is 100% or 0%
      if (pct === 100) {
        return makeDecision(
          true,
          'ENVIRONMENT_DEFAULT',
          `Environment "${env}" configuration enabled at 100%`,
          100
        )
      }
      if (pct === 0) {
        return makeDecision(
          false,
          'ENVIRONMENT_DEFAULT',
          `Environment "${env}" configuration disabled at 0%`,
          0
        )
      }

      // Otherwise fall back to envRule.enabled
      return makeDecision(
        envRule.enabled,
        'ENVIRONMENT_DEFAULT',
        `Environment "${env}" default enabled=${envRule.enabled}`,
        envRule.enabled ? pct : 0
      )
    }

    // ── 9. Unknown / Unregistered Flag Fallback ──────────────────────────────
    return makeDecision(
      false,
      'DEFAULT_FALLBACK',
      `Flag "${flagKey}" not registered; falling back closed to false`,
      0
    )
  }

  /**
   * Convenience boolean evaluator.
   */
  public isEnabled(
    flagKey: string,
    contextOrEntityId?: FlagEvaluationContext | string
  ): boolean {
    return this.evaluate(flagKey, contextOrEntityId).enabled
  }

  /**
   * Sets a dynamic runtime override for a feature flag.
   */
  public setOverride(
    flagKey: string,
    override: Partial<FeatureFlagOverride>,
    operator: string = 'system'
  ): void {
    const existing = this.overrides.get(flagKey) || {
      updatedAt: new Date().toISOString(),
    }

    const merged: FeatureFlagOverride = {
      ...existing,
      ...override,
      updatedAt: new Date().toISOString(),
      updatedBy: operator,
    }

    this.overrides.set(flagKey, merged)

    logger.warn(`[FeatureFlag] Runtime override set for "${flagKey}"`, {
      flagKey,
      override: merged,
      operator,
    })

    this.syncOverrideToRedis(flagKey, merged)
  }

  /**
   * Adjusts the rollout percentage for staged release (0% -> 10% -> 25% -> 50% -> 100%).
   */
  public stagedRollout(
    flagKey: string,
    percentage: number,
    operator: string = 'system'
  ): void {
    const clamped = Math.max(0, Math.min(100, percentage))
    this.setOverride(
      flagKey,
      {
        rolloutPercentage: clamped,
        enabled: clamped > 0,
        rolledBack: false,
      },
      operator
    )

    logger.warn(
      `[FeatureFlag] Staged rollout updated for "${flagKey}" to ${clamped}% by ${operator}`,
      {
        flagKey,
        rolloutPercentage: clamped,
        operator,
      }
    )
  }

  /**
   * Emergency Rollback (#494):
   * Immediately disables a feature flag, drops rollout percentage to 0,
   * engages rollback state, records audit log and Prometheus rollback metric.
   */
  public rollback(
    flagKey: string,
    reason: string,
    operator: string = 'system'
  ): RollbackEvent {
    const def = this.flags.get(flagKey)
    const currentOverride = this.overrides.get(flagKey)
    const now = new Date().toISOString()

    const previousState = {
      enabled: currentOverride?.enabled ?? def?.environments[getCurrentEnvironment()]?.enabled,
      rolloutPercentage:
        currentOverride?.rolloutPercentage ??
        def?.environments[getCurrentEnvironment()]?.rolloutPercentage,
    }

    // Set definition rollback state
    if (def) {
      def.rolledBack = true
      def.rollbackReason = reason
      def.rollbackTimestamp = now
      def.rollbackOperator = operator
    }

    // Set runtime override to ensure 0% rollout and disabled state across all checks
    this.overrides.set(flagKey, {
      enabled: false,
      rolloutPercentage: 0,
      rolledBack: true,
      rollbackReason: reason,
      updatedAt: now,
      updatedBy: operator,
    })

    const event: RollbackEvent = {
      flagKey,
      reason,
      operator,
      timestamp: now,
      previousState,
    }

    this.rollbackHistory.push(event)

    // Acceptance criterion: Logging captures flag evaluation decisions and rollbacks
    logger.error(
      `[FeatureFlag] EMERGENCY ROLLBACK TRIGGERED for "${flagKey}" by ${operator}: ${reason}`,
      {
        event: 'feature_flag_rollback',
        flagKey,
        reason,
        operator,
        previousState,
        timestamp: now,
      }
    )

    recordFeatureFlagRollback(flagKey, operator)
    setFeatureFlagRolloutGauge(flagKey, 0)

    this.syncOverrideToRedis(flagKey, {
      enabled: false,
      rolloutPercentage: 0,
      rolledBack: true,
      rollbackReason: reason,
      updatedAt: now,
      updatedBy: operator,
    })

    return event
  }

  /**
   * Engages an emergency kill switch on a flag.
   */
  public emergencyDisable(
    flagKey: string,
    reason: string,
    operator: string = 'system'
  ): void {
    this.rollback(flagKey, reason, operator)
  }

  /**
   * Platform-wide emergency disablement.
   */
  public emergencyDisableAll(
    reason: string,
    operator: string = 'system'
  ): void {
    logger.error(
      `[FeatureFlag] PLATFORM EMERGENCY DISABLE ALL TRIGGERED by ${operator}: ${reason}`,
      {
        event: 'feature_flag_disable_all',
        reason,
        operator,
      }
    )
    this.setOverride(
      'emergency_maintenance_mode',
      {
        enabled: true,
        rolloutPercentage: 100,
      },
      operator
    )
  }

  /**
   * Clears overrides and resets a feature flag back to its default environment configuration.
   */
  public reset(flagKey: string, operator: string = 'system'): void {
    const def = this.flags.get(flagKey)
    if (def) {
      def.rolledBack = false
      delete def.rollbackReason
      delete def.rollbackTimestamp
      delete def.rollbackOperator
    }
    this.overrides.delete(flagKey)

    logger.info(
      `[FeatureFlag] Reset flag "${flagKey}" to default environment config by ${operator}`,
      {
        flagKey,
        operator,
      }
    )

    this.removeOverrideFromRedis(flagKey)
  }

  /**
   * Resets all runtime overrides (primarily for test suite hermeticity).
   */
  public resetAll(): void {
    for (const [key, def] of this.flags.entries()) {
      def.rolledBack = false
      delete def.rollbackReason
      delete def.rollbackTimestamp
      delete def.rollbackOperator
    }
    this.overrides.clear()
    this.rollbackHistory = []
  }

  /**
   * Retrieves all registered feature flags with current evaluation status.
   */
  public getAllFlags(
    context?: FlagEvaluationContext
  ): Array<FeatureFlagDefinition & { currentEvaluation: FlagEvaluationResult }> {
    return Array.from(this.flags.values()).map((def) => ({
      ...def,
      currentEvaluation: this.evaluate(def.key, context),
    }))
  }

  /**
   * Returns recorded rollback history.
   */
  public getRollbackHistory(): RollbackEvent[] {
    return [...this.rollbackHistory]
  }

  // ── Redis Distributed Sync (#494) ──────────────────────────────────────────

  private async syncOverrideToRedis(
    flagKey: string,
    override: FeatureFlagOverride
  ): Promise<void> {
    try {
      const client = getRedisClient()
      if (!client) return

      await cacheSet(`${REDIS_OVERRIDES_KEY}:${flagKey}`, override, 86400 * 7)
      await client.publish(
        REDIS_UPDATES_CHANNEL,
        JSON.stringify({ flagKey, override })
      )
    } catch (err) {
      logger.warn('[FeatureFlag] Failed to sync override to Redis', {
        flagKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async removeOverrideFromRedis(flagKey: string): Promise<void> {
    try {
      const client = getRedisClient()
      if (!client) return

      await client.del(`${REDIS_OVERRIDES_KEY}:${flagKey}`)
      await client.publish(
        REDIS_UPDATES_CHANNEL,
        JSON.stringify({ flagKey, reset: true })
      )
    } catch (err) {
      logger.warn('[FeatureFlag] Failed to delete override from Redis', {
        flagKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Initial bootstrap from Redis cache to pick up any active overrides across pods.
   */
  public async syncFromRedis(): Promise<void> {
    const client = getRedisClient()
    if (!client) return

    try {
      for (const flagKey of this.flags.keys()) {
        const cached = await cacheGet<FeatureFlagOverride>(
          `${REDIS_OVERRIDES_KEY}:${flagKey}`
        )
        if (cached) {
          this.overrides.set(flagKey, cached)
        }
      }

      if (!this.redisSyncSubscribed) {
        this.redisSyncSubscribed = true
        const sub = client.duplicate()
        await sub.subscribe(REDIS_UPDATES_CHANNEL)
        sub.on('message', (_channel, message) => {
          try {
            const data = JSON.parse(message)
            if (data.reset && data.flagKey) {
              this.overrides.delete(data.flagKey)
            } else if (data.flagKey && data.override) {
              this.overrides.set(data.flagKey, data.override)
            }
          } catch {
            // Ignore parse errors from invalid Redis pubsub payloads
          }
        })
      }
    } catch (err) {
      logger.warn('[FeatureFlag] Failed to initialize Redis sync', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// Global Singleton Instance
export const featureFlagManager = new FeatureFlagManager()

/**
 * Convenience helper to evaluate a feature flag.
 * Supports string entityId or full FlagEvaluationContext.
 */
export function isFeatureEnabled(
  flagKey: string,
  contextOrEntityId?: FlagEvaluationContext | string
): boolean {
  return featureFlagManager.isEnabled(flagKey, contextOrEntityId)
}

/**
 * Convenience helper to evaluate and inspect a feature flag result.
 */
export function evaluateFeatureFlag(
  flagKey: string,
  contextOrEntityId?: FlagEvaluationContext | string
): FlagEvaluationResult {
  return featureFlagManager.evaluate(flagKey, contextOrEntityId)
}
