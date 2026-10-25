# Feature Flag Configuration, Staged Rollout, and Rollback System (#494)

The central Feature Flag mechanism provides a resilient, environment-aware control plane for progressive releases, staged canary adoptions, and instantaneous emergency rollbacks in production.

---

## 1. Architecture & Core Concepts

The system is centered around `FeatureFlagManager` (`src/config/featureFlags.ts`), exported globally as `featureFlagManager`.

### Multi-Tier Resolution Hierarchy

Flag evaluation follows a strict, fail-closed resolution pipeline:

```
┌────────────────────────────────────────────────────────┐
│ 1. Global Maintenance Mode (emergency_maintenance_mode) │ ──> Disabled
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 2. Flag-Level Kill Switch (def.killSwitch)             │ ──> Disabled
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 3. Emergency Rollback (def.rolledBack / Env Rollback)   │ ──> Disabled (0%)
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 4. Entity Blocklist (def.blocklist / env.blocklist)     │ ──> Disabled
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 5. Entity Allowlist (def.allowlist / env.allowlist)     │ ──> Enabled (100%)
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 6. Runtime Dynamic Overrides (Admin API / Redis)       │ ──> Dynamic / Rollout %
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 7. Environment Variable Overrides                      │ ──> Env Val / Env %
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 8. Environment Baseline (dev / test / staging / prod)  │ ──> Env Default / %
└────────────────────────────────────────────────────────┘
                           │
┌────────────────────────────────────────────────────────┐
│ 9. Unregistered Flag Fallback (Fail Closed)            │ ──> False
└────────────────────────────────────────────────────────┘
```

---

## 2. Environment Awareness

Feature flags natively differentiate behavior across execution environments (`development`, `test`, `staging`, `production`), determined via `NODE_ENV`.

### Built-in Flag Catalog (`DEFAULT_FEATURE_FLAGS`)

| Flag Key | Description | Dev | Test | Staging | Production |
| :--- | :--- | :---: | :---: | :---: | :---: |
| `agent_autonomous_rebalance` | Automated agent-driven portfolio rebalancing | 100% | 100% | 50% | 0% (Off) |
| `smart_dca_engine` | Volatility-aware adaptive recurring deposits engine | 100% | 100% | 25% | 0% (Off) |
| `enhanced_stellar_routing` | Horizon liquidity path finding and smart fee routing | 100% | 100% | 100% | 10% |
| `ai_assistant_tool_calling` | Conversational assistant with autonomous tool invocation | 100% | 100% | 50% | 0% (Off) |
| `circuit_breaker_v2` | Dynamic volatility and drawdown circuit breaker trip rules | 100% | 100% | 100% | 100% (On) |
| `fast_fiat_onramp` | Direct instant on-ramp quoting and locking | 100% | 100% | 100% | 0% (Off) |
| `emergency_maintenance_mode` | Platform-wide guard to halt state-mutating requests | Off | Off | Off | Off |

### Environment Variable Overrides

Any flag can be modified or overridden via environment variables without requiring a code release:

- **State Override**: `FEATURE_FLAG_<KEY_UPPERCASE>=true|false`  
  *Example*: `FEATURE_FLAG_SMART_DCA_ENGINE=true`
- **Percentage Override**: `FEATURE_FLAG_<KEY_UPPERCASE>_PERCENTAGE=0..100`  
  *Example*: `FEATURE_FLAG_ENHANCED_STELLAR_ROUTING_PERCENTAGE=25`
- **Kill-Switch Override**: `FEATURE_FLAG_<KEY_UPPERCASE>_KILL_SWITCH=true`  
  *Example*: `FEATURE_FLAG_FAST_FIAT_ONRAMP_KILL_SWITCH=true`
- **Emergency Rollback List**: `FEATURE_FLAGS_ROLLBACK=flag1,flag2,flag3`  
  *Example*: `FEATURE_FLAGS_ROLLBACK=smart_dca_engine,fast_fiat_onramp`

---

## 3. Deterministic Staged Rollout

Staged releases use cryptographic SHA-256 entity hashing (`hashEntityToPercentage`) to ensure consistent, monotonic, and sticky cohort assignment:

$$\text{bucket} = \text{parseInt}\big(\text{SHA256}(\text{flagKey} : \text{entityId})[0..8], 16\big) \pmod{100}$$

### Staged Rollout Progression

1. **Phase 0 (Internal / Canary)**: `0%` rollout. Selected testers enabled via `allowlist: ['user-id-1', 'user-id-2']`.
2. **Phase 1 (10% Tier)**: `10%` rollout (`stagedRollout(flag, 10)`).
3. **Phase 2 (25% Tier)**: `25%` rollout (`stagedRollout(flag, 25)`).
4. **Phase 3 (50% Tier)**: `50%` rollout (`stagedRollout(flag, 50)`).
5. **Phase 4 (General Availability - 100%)**: `100%` rollout (`stagedRollout(flag, 100)`).

Because the hashing is monotonic:
- Any entity included in the 10% tier remains included in the 25%, 50%, and 100% tiers.
- No user suffers flip-flopping feature availability between server restarts or across horizontally scaled cluster pods.

---

## 4. Emergency Rollback Runbook

When an anomaly, exploit, or regression occurs in production, operators have 4 independent, fast rollback paths:

### Path A: Fast Admin API Rollback (< 1 second)

Requires `flags:write` or `super` admin scope.

```bash
# Roll back a specific feature flag immediately
curl -X POST https://api.neurowealth.app/api/v1/admin/feature-flags/smart_dca_engine/rollback \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "High slippage observed in Horizon liquidity pools"}'
```

**What occurs instantly:**
1. Rollout percentage drops to `0%`.
2. Flag is marked `rolledBack = true`.
3. Rollback event is recorded into memory and audit history.
4. Winston logs an `error` level `[FeatureFlag] EMERGENCY ROLLBACK TRIGGERED`.
5. Prometheus metric `feature_flag_rollbacks_total{flag="smart_dca_engine"}` increments.
6. Event is published to Redis pub/sub (`neurowealth:feature_flags:updates`) to immediately sync all active cluster pods.

### Path B: Platform Emergency Maintenance Mode

To halt all state-mutating requests platform-wide during a critical incident:

```bash
curl -X POST https://api.neurowealth.app/api/v1/admin/feature-flags/emergency-disable-all \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Investigating zero-day smart contract vulnerability"}'
```

- Halts all `POST`, `PUT`, `DELETE`, and `PATCH` requests with `503 SERVICE_UNAVAILABLE` and `EMERGENCY_MAINTENANCE` code.
- Read-only `GET` endpoints, `/health/*`, `/metrics`, and `/api/v1/admin/*` remain operational so SRE can inspect and remediate.

### Path C: Container Environment Variable Emergency Disable

If the Admin API or database is unreachable, update container / pod environment variables in Kubernetes or ECS:

```bash
# Rollback specific flags
FEATURE_FLAGS_ROLLBACK=smart_dca_engine,fast_fiat_onramp

# Or engage flag kill-switch
FEATURE_FLAG_SMART_DCA_ENGINE_KILL_SWITCH=true
```

### Path D: Redis Emergency Rollback

If operating directly through Redis CLI:

```bash
redis-cli PUBLISH neurowealth:feature_flags:updates \
  '{"flagKey":"smart_dca_engine","override":{"enabled":false,"rolloutPercentage":0,"rolledBack":true,"rollbackReason":"Direct redis rollback"}}'
```

---

## 5. Structured Decision Logging & Observability

Every flag evaluation decision is captured with structured Winston logging:

```json
{
  "timestamp": "2026-09-26T23:30:00.000Z",
  "level": "info",
  "message": "[FeatureFlag] Evaluated flag \"smart_dca_engine\": ENABLED (PERCENTAGE_ROLLOUT_MATCH)",
  "event": "feature_flag_evaluation",
  "flag": "smart_dca_engine",
  "enabled": true,
  "decision": "PERCENTAGE_ROLLOUT_MATCH",
  "reason": "Runtime staged rollout (25%) for entity bucket 12",
  "environment": "production",
  "entityId": "usr_99812739",
  "rolloutPercentage": 25
}
```

### Decision Types

- `GLOBAL_MAINTENANCE`: Disabled due to active platform maintenance mode.
- `KILL_SWITCH`: Disabled due to an active flag kill switch.
- `EMERGENCY_ROLLBACK`: Disabled due to an emergency rollback event.
- `BLOCKLIST`: Entity is explicitly blocked.
- `ALLOWLIST`: Entity is explicitly allowed.
- `RUNTIME_OVERRIDE`: Dynamic override set via Admin API.
- `ENV_VAR_OVERRIDE`: Overridden via environment variable.
- `PERCENTAGE_ROLLOUT_MATCH`: Entity fell within the active percentage rollout.
- `PERCENTAGE_ROLLOUT_MISMATCH`: Entity fell outside the active percentage rollout.
- `ENVIRONMENT_DEFAULT`: Default state for the current environment.
- `DEFAULT_FALLBACK`: Unrecognized flag evaluated (fail-closed to false).

### Prometheus Metrics

- `feature_flag_evaluations_total{flag, decision, enabled}`: Counter tracking evaluations.
- `feature_flag_rollbacks_total{flag, operator}`: Counter tracking rollback invocations.
- `feature_flag_rollout_percentage{flag}`: Gauge reflecting active rollout percentage (0-100).

---

## 6. Admin API Reference

All endpoints are mounted under `/api/v1/admin/feature-flags` and require admin authentication:

- `flags:read` scope: Read-only access (`GET`).
- `flags:write` scope: Rollout and rollback mutation access (`POST`, `PUT`).
- `super` scope: Inherits all permissions.

| Method | Endpoint | Required Scope | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/feature-flags` | `flags:read` | List all flags, environment baseline, and evaluation status. |
| `GET` | `/feature-flags/history` | `flags:read` | List emergency rollback history and audit log. |
| `GET` | `/feature-flags/:key` | `flags:read` | Inspect single flag configuration and evaluation. |
| `PUT` | `/feature-flags/:key` | `flags:write` | Set runtime overrides (enabled, rolloutPercentage, allowlist, blocklist). |
| `POST` | `/feature-flags/:key/staged-rollout` | `flags:write` | Set staged rollout percentage (0 - 100). |
| `POST` | `/feature-flags/:key/rollback` | `flags:write` | Trigger fast emergency rollback with required reason. |
| `POST` | `/feature-flags/:key/reset` | `flags:write` | Reset flag back to default environment baseline. |
| `POST` | `/feature-flags/emergency-disable-all` | `flags:write` | Activate platform-wide emergency maintenance mode. |

---

## 7. Developer Integration

### Protecting Routes via Middleware

```typescript
import { requireFeatureFlag } from '../middleware/featureFlags'

// Protect an entire route or endpoint
router.post(
  '/rebalance/execute',
  requireFeatureFlag('agent_autonomous_rebalance', {
    customMessage: 'Autonomous portfolio rebalancing is temporarily disabled',
  }),
  rebalanceHandler
)
```

### Checking Flags in Business Logic

```typescript
import { isFeatureEnabled, evaluateFeatureFlag } from '../config/featureFlags'

// Simple boolean check
if (isFeatureEnabled('smart_dca_engine', req.user?.id)) {
  await executeSmartDca(order)
} else {
  await executeStandardDca(order)
}

// Detailed inspection
const evaluation = evaluateFeatureFlag('fast_fiat_onramp', {
  entityId: req.user?.id,
  environment: 'production',
})
logger.info(`Flag evaluated: ${evaluation.enabled} via ${evaluation.decision}`)
```
