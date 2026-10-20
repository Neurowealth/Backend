import {
  FeatureFlagManager,
  hashEntityToPercentage,
  getCurrentEnvironment,
  DEFAULT_FEATURE_FLAGS,
} from '../../../src/config/featureFlags'
import { logger } from '../../../src/utils/logger'

describe('Feature Flags Configuration and Evaluation (#494)', () => {
  let manager: FeatureFlagManager
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    manager = new FeatureFlagManager()
  })

  afterEach(() => {
    process.env = originalEnv
    manager.resetAll()
    jest.restoreAllMocks()
  })

  describe('Default Catalog and Registration', () => {
    it('initializes with all default feature flags', () => {
      const flags = manager.getAllFlags()
      const keys = flags.map((f) => f.key)

      expect(keys).toContain('agent_autonomous_rebalance')
      expect(keys).toContain('smart_dca_engine')
      expect(keys).toContain('enhanced_stellar_routing')
      expect(keys).toContain('ai_assistant_tool_calling')
      expect(keys).toContain('circuit_breaker_v2')
      expect(keys).toContain('fast_fiat_onramp')
      expect(keys).toContain('emergency_maintenance_mode')
    })

    it('allows registering custom feature flags', () => {
      manager.registerFlag({
        key: 'experimental_order_routing',
        description: 'Next-gen routing engine',
        environments: {
          development: { enabled: true, rolloutPercentage: 100 },
          test: { enabled: true, rolloutPercentage: 100 },
          staging: { enabled: false, rolloutPercentage: 0 },
          production: { enabled: false, rolloutPercentage: 0 },
        },
      })

      const flag = manager.getFlag('experimental_order_routing')
      expect(flag).toBeDefined()
      expect(flag?.key).toBe('experimental_order_routing')
      expect(manager.isEnabled('experimental_order_routing', { environment: 'development' })).toBe(true)
      expect(manager.isEnabled('experimental_order_routing', { environment: 'production' })).toBe(false)
    })

    it('falls back closed to false for unknown flags', () => {
      const result = manager.evaluate('non_existent_flag')
      expect(result.enabled).toBe(false)
      expect(result.decision).toBe('DEFAULT_FALLBACK')
    })
  })

  describe('Environment Awareness', () => {
    it('correctly resolves environment from NODE_ENV', () => {
      process.env.NODE_ENV = 'production'
      expect(getCurrentEnvironment()).toBe('production')

      process.env.NODE_ENV = 'staging'
      expect(getCurrentEnvironment()).toBe('staging')

      process.env.NODE_ENV = 'test'
      expect(getCurrentEnvironment()).toBe('test')

      process.env.NODE_ENV = 'development'
      expect(getCurrentEnvironment()).toBe('development')

      process.env.NODE_ENV = 'unknown_env'
      expect(getCurrentEnvironment()).toBe('development')
    })

    it('evaluates flags according to the specified environment', () => {
      // In DEFAULT_FEATURE_FLAGS, agent_autonomous_rebalance is:
      // dev: 100%, test: 100%, staging: 50%, prod: 0%
      const devRes = manager.evaluate('agent_autonomous_rebalance', { environment: 'development' })
      expect(devRes.enabled).toBe(true)
      expect(devRes.environment).toBe('development')

      const prodRes = manager.evaluate('agent_autonomous_rebalance', { environment: 'production' })
      expect(prodRes.enabled).toBe(false)
      expect(prodRes.environment).toBe('production')
    })
  })

  describe('Deterministic Hashing and Staged Rollout', () => {
    it('produces consistent, deterministic hash buckets for identical entity inputs', () => {
      const bucket1 = hashEntityToPercentage('smart_dca_engine', 'user_12345')
      const bucket2 = hashEntityToPercentage('smart_dca_engine', 'user_12345')
      const bucket3 = hashEntityToPercentage('smart_dca_engine', 'user_12345')

      expect(bucket1).toBe(bucket2)
      expect(bucket2).toBe(bucket3)
      expect(bucket1).toBeGreaterThanOrEqual(0)
      expect(bucket1).toBeLessThan(100)
    })

    it('handles empty or whitespace entity IDs gracefully', () => {
      expect(hashEntityToPercentage('flag', '')).toBe(0)
    })

    it('implements monotonic staged rollouts across percentages', () => {
      // Find two users with known buckets
      const userA = 'user_alpha'
      const bucketA = hashEntityToPercentage('smart_dca_engine', userA)

      // Test progressive staged rollout
      // If percentage <= bucketA, enabled is false; if percentage > bucketA, enabled is true
      manager.stagedRollout('smart_dca_engine', bucketA)
      expect(manager.isEnabled('smart_dca_engine', userA)).toBe(false)

      manager.stagedRollout('smart_dca_engine', bucketA + 1)
      expect(manager.isEnabled('smart_dca_engine', userA)).toBe(true)

      // Advance to 100%
      manager.stagedRollout('smart_dca_engine', 100)
      expect(manager.isEnabled('smart_dca_engine', userA)).toBe(true)

      // Drop to 0%
      manager.stagedRollout('smart_dca_engine', 0)
      expect(manager.isEnabled('smart_dca_engine', userA)).toBe(false)
    })
  })

  describe('Allowlists and Blocklists', () => {
    it('allows an entity explicitly included on the allowlist even if rollout is 0%', () => {
      manager.registerFlag({
        key: 'beta_feature',
        description: 'Beta feature',
        environments: {
          production: { enabled: false, rolloutPercentage: 0 },
          development: { enabled: false, rolloutPercentage: 0 },
          test: { enabled: false, rolloutPercentage: 0 },
          staging: { enabled: false, rolloutPercentage: 0 },
        },
        allowlist: ['whitelisted_user_1', 'whitelisted_user_2'],
      })

      const resAllowed = manager.evaluate('beta_feature', {
        entityId: 'whitelisted_user_1',
        environment: 'production',
      })
      expect(resAllowed.enabled).toBe(true)
      expect(resAllowed.decision).toBe('ALLOWLIST')

      const resOther = manager.evaluate('beta_feature', {
        entityId: 'normal_user',
        environment: 'production',
      })
      expect(resOther.enabled).toBe(false)
    })

    it('blocks an entity explicitly included on the blocklist even if rollout is 100%', () => {
      manager.registerFlag({
        key: 'ga_feature',
        description: 'GA feature',
        environments: {
          production: { enabled: true, rolloutPercentage: 100 },
          development: { enabled: true, rolloutPercentage: 100 },
          test: { enabled: true, rolloutPercentage: 100 },
          staging: { enabled: true, rolloutPercentage: 100 },
        },
        blocklist: ['blocked_user_bad_actor'],
      })

      const resBlocked = manager.evaluate('ga_feature', {
        entityId: 'blocked_user_bad_actor',
        environment: 'production',
      })
      expect(resBlocked.enabled).toBe(false)
      expect(resBlocked.decision).toBe('BLOCKLIST')

      const resAllowed = manager.evaluate('ga_feature', {
        entityId: 'good_user',
        environment: 'production',
      })
      expect(resAllowed.enabled).toBe(true)
    })

    it('prioritizes blocklist over allowlist if an entity appears in both', () => {
      manager.registerFlag({
        key: 'conflict_feature',
        description: 'Test conflict',
        environments: {
          production: { enabled: true, rolloutPercentage: 100 },
          development: { enabled: true, rolloutPercentage: 100 },
          test: { enabled: true, rolloutPercentage: 100 },
          staging: { enabled: true, rolloutPercentage: 100 },
        },
        allowlist: ['user_in_both'],
        blocklist: ['user_in_both'],
      })

      const result = manager.evaluate('conflict_feature', {
        entityId: 'user_in_both',
        environment: 'production',
      })
      expect(result.enabled).toBe(false)
      expect(result.decision).toBe('BLOCKLIST')
    })
  })

  describe('Runtime Overrides & Management API', () => {
    it('sets and removes runtime overrides', () => {
      // In production, circuit_breaker_v2 is enabled
      expect(manager.isEnabled('circuit_breaker_v2', { environment: 'production' })).toBe(true)

      // Set runtime override to false
      manager.setOverride('circuit_breaker_v2', { enabled: false }, 'admin-alice')
      expect(manager.isEnabled('circuit_breaker_v2', { environment: 'production' })).toBe(false)

      const evalRes = manager.evaluate('circuit_breaker_v2', { environment: 'production' })
      expect(evalRes.decision).toBe('RUNTIME_OVERRIDE')

      // Reset
      manager.reset('circuit_breaker_v2', 'admin-alice')
      expect(manager.isEnabled('circuit_breaker_v2', { environment: 'production' })).toBe(true)
    })
  })

  describe('Emergency Rollback and Kill Switches', () => {
    it('executes fast emergency rollback, dropping percentage to 0 and recording history', () => {
      // Setup active staged rollout
      manager.stagedRollout('smart_dca_engine', 50, 'release-manager')
      expect(manager.getFlag('smart_dca_engine')?.rolledBack).toBeFalsy()

      // Trigger emergency rollback
      const rollbackEvent = manager.rollback(
        'smart_dca_engine',
        'High latency detected on Horizon liquidity pool',
        'sre-oncall-bob'
      )

      expect(rollbackEvent.flagKey).toBe('smart_dca_engine')
      expect(rollbackEvent.reason).toBe('High latency detected on Horizon liquidity pool')
      expect(rollbackEvent.operator).toBe('sre-oncall-bob')
      expect(rollbackEvent.timestamp).toBeDefined()

      // Flag must now evaluate to false immediately
      const evalRes = manager.evaluate('smart_dca_engine')
      expect(evalRes.enabled).toBe(false)
      expect(evalRes.decision).toBe('EMERGENCY_ROLLBACK')
      expect(evalRes.rolloutPercentage).toBe(0)

      // History must record the event
      const history = manager.getRollbackHistory()
      expect(history.length).toBe(1)
      expect(history[0].flagKey).toBe('smart_dca_engine')

      // Reset restores original state
      manager.reset('smart_dca_engine', 'admin-alice')
      const afterReset = manager.evaluate('smart_dca_engine', { environment: 'development' })
      expect(afterReset.enabled).toBe(true)
    })

    it('supports platform-wide emergencyDisableAll by engaging emergency maintenance mode', () => {
      manager.emergencyDisableAll('Critical security audit event', 'security-team')

      const res1 = manager.evaluate('agent_autonomous_rebalance', { environment: 'development' })
      expect(res1.enabled).toBe(false)
      expect(res1.decision).toBe('GLOBAL_MAINTENANCE')

      const res2 = manager.evaluate('circuit_breaker_v2', { environment: 'development' })
      expect(res2.enabled).toBe(false)
      expect(res2.decision).toBe('GLOBAL_MAINTENANCE')
    })
  })

  describe('Environment Variable Overrides', () => {
    it('overrides flag state via FEATURE_FLAG_<FLAG_KEY>', () => {
      process.env.FEATURE_FLAG_AGENT_AUTONOMOUS_REBALANCE = 'true'
      const res = manager.evaluate('agent_autonomous_rebalance', { environment: 'production' })
      expect(res.enabled).toBe(true)
      expect(res.decision).toBe('ENV_VAR_OVERRIDE')
    })

    it('overrides rollout percentage via FEATURE_FLAG_<FLAG_KEY>_PERCENTAGE', () => {
      process.env.FEATURE_FLAG_SMART_DCA_ENGINE_PERCENTAGE = '100'
      const res = manager.evaluate('smart_dca_engine', {
        entityId: 'user_any',
        environment: 'production',
      })
      expect(res.enabled).toBe(true)
      expect(res.decision).toBe('PERCENTAGE_ROLLOUT_MATCH')
      expect(res.rolloutPercentage).toBe(100)
    })

    it('enforces flag kill-switch via FEATURE_FLAG_<FLAG_KEY>_KILL_SWITCH', () => {
      process.env.FEATURE_FLAG_CIRCUIT_BREAKER_V2_KILL_SWITCH = 'true'
      const res = manager.evaluate('circuit_breaker_v2', { environment: 'development' })
      expect(res.enabled).toBe(false)
      expect(res.decision).toBe('KILL_SWITCH')
    })

    it('triggers emergency rollback via FEATURE_FLAGS_ROLLBACK list', () => {
      process.env.FEATURE_FLAGS_ROLLBACK = 'agent_autonomous_rebalance,fast_fiat_onramp'
      const res1 = manager.evaluate('agent_autonomous_rebalance', { environment: 'development' })
      expect(res1.enabled).toBe(false)
      expect(res1.decision).toBe('EMERGENCY_ROLLBACK')

      const res2 = manager.evaluate('fast_fiat_onramp', { environment: 'development' })
      expect(res2.enabled).toBe(false)
      expect(res2.decision).toBe('EMERGENCY_ROLLBACK')

      // Other flags unaffected
      const res3 = manager.evaluate('circuit_breaker_v2', { environment: 'development' })
      expect(res3.enabled).toBe(true)
    })
  })

  describe('Structured Decision Logging', () => {
    it('logs structured evaluation metadata via Winston logger', () => {
      const loggerSpy = jest.spyOn(logger, 'info')

      const result = manager.evaluate('agent_autonomous_rebalance', {
        entityId: 'user_logging_test',
        environment: 'development',
      })

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FeatureFlag] Evaluated flag "agent_autonomous_rebalance"'),
        expect.objectContaining({
          event: 'feature_flag_evaluation',
          flag: 'agent_autonomous_rebalance',
          enabled: result.enabled,
          decision: result.decision,
          environment: 'development',
          entityId: 'user_logging_test',
        })
      )
    })
  })
})
