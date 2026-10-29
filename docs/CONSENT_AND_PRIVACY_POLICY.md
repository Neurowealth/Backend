# User Consent and Data-Processing Policy Framework

## Overview

This policy framework defines mandatory consent checks, workflow privacy boundaries, and auditable exception logic for high-risk data-processing and operational operations in the NeuroWealth Backend system.

---

## 1. High-Risk Workflows & Mandatory Consent Scopes

Every high-risk operation requires explicit, un-revoked user consent prior to execution.

| High-Risk Workflow | Operational Scope | Mandatory Consent Scope | Description |
|---|---|---|---|
| `AUTOMATED_TRADING` | Copy trading, automated strategy execution, rebalancing | `consent:automated_trading` | Authorizes background agent loops to place orders and execute strategy transactions on user's behalf. |
| `PROFILE_ANALYTICS` | User profiling, risk scoring, behavioral metrics | `consent:data_processing` | Authorizes collection and processing of financial history for personalized analytics. |
| `THIRD_PARTY_EXPORT` | Exporting accounting data to QBO/Xero, external SMS/Voice | `consent:third_party_sharing` | Authorizes sharing transaction and profile data with third-party service integrators. |
| `NOTIFICATIONS_MARKETING` | Promotional push notifications, email campaigns | `consent:marketing` | Authorizes sending marketing and promotional updates. |
| `AI_PORTFOLIO_ADVISORY` | LLM-generated portfolio allocation suggestions | `consent:ai_advisory` | Authorizes processing portfolio state with AI model providers for strategy insights. |
| `TELEMETRY_COLLECTION` | Client operational telemetry & event tracking | `consent:telemetry` | Authorizes collecting performance telemetry and diagnostic events. |

---

## 2. Policy Enforcement & Backend Checks

Backend endpoints and background workers enforce consent boundaries using `validateWorkflowConsent()` or the `requireConsentPolicy()` middleware:

```typescript
import { requireConsentPolicy } from '../middleware/consentPolicy'

// Protecting high-risk automated trading routes
router.post(
  '/strategies/execute',
  requireConsentPolicy('AUTOMATED_TRADING'),
  async (req, res) => { ... }
)
```

If a required consent flag is missing or revoked:
1. The request is rejected with HTTP 403 Forbidden.
2. Error response payload includes `code: "CONSENT_POLICY_DENIED"` and the missing `requiredScope`.
3. The violation is logged to security telemetry.

---

## 2a. Consent Versioning and Re-consent

A consent is only valid for the purpose text the user agreed to. Each consent is stored as a `ConsentRecord`:

| Field | Meaning |
|---|---|
| `granted` | Whether the scope is currently granted. |
| `policyVersion` | `CONSENT_POLICY_VERSION` at the time of the last grant or withdrawal. |
| `purposesHash` | SHA-256 of the scope's purpose text (`CONSENT_PURPOSES`) at that time. |
| `updatedAt` | ISO timestamp of the last change. |
| `history` | Ordered `granted` / `withdrawn` entries, each with its `policyVersion`, `purposesHash` and timestamp. |

Use `grantConsent(scope, previous?)` and `withdrawConsent(scope, previous?)` to produce records; they return a new record and append to `history`.

### When consent is invalidated

`purposesHash` is derived from the purpose string for that scope in `CONSENT_PURPOSES`. Editing a scope's purpose text changes its hash, so existing consents for **that scope only** stop counting. Consents for unchanged scopes stay valid. When a change is material, also bump `CONSENT_POLICY_VERSION` so the history records which revision each consent belongs to. Keep the purpose text in `CONSENT_PURPOSES` and the table in section 1 in sync.

### Enforcement

- `validateWorkflowConsent()` returns `allowed: false` with `reconsentRequired: true` when the stored `purposesHash` no longer matches the current one.
- `requireConsentPolicy()` answers HTTP 403 with `code: "CONSENT_RECONSENT_REQUIRED"`, plus the current `policyVersion` and `purposesHash`, so a client can prompt the user to re-consent. A missing or withdrawn consent keeps the `CONSENT_POLICY_DENIED` code.
- Once the user re-consents with `grantConsent()`, the new record carries the current hash and the workflow is allowed again.
- The block is logged with the consented and current policy versions and hashes. Auditable bypasses (section 3) still apply to stale consents.
- Only high-risk workflows are gated. Endpoints that do not use `requireConsentPolicy()` are unaffected while a re-consent is pending.
- A plain `true` in the consent map is the legacy unversioned form. It is still honoured, but it carries no version, so it can't be invalidated by a purpose change. Store `ConsentRecord`s for new consents.

---

## 3. Auditable Exceptions and Bypass Logic

In specific operational, legal, or emergency scenarios, system processes or administrators may bypass standard consent checks under strict audit controls.

### Supported Bypass Reasons

1. `LEGAL_COMPLIANCE_HOLD`: Required for compliance audits, sanctions screening, or legal hold requests.
2. `EMERGENCY_CIRCUIT_BREAKER`: Activated during market volatility or system vulnerability emergencies to safeguard user funds.
3. `SECURITY_AUDIT_OVERRIDE`: Authorized security audits or threat investigation passes.
4. `SYSTEM_ADMIN_MAINTENANCE`: System-level maintenance and data migration sweeps.

### Bypass Audit Requirements

All bypass calls MUST specify:
- An authorized `bypassReason`.
- A detailed `bypassJustification` string (minimum 10 characters).
- The identity of the invoking system or admin key.

Every bypass invocation emits a high-priority audit log entry (`[Consent Policy Audit]`) to immutable audit trails. Bypasses without valid justifications are strictly rejected.
