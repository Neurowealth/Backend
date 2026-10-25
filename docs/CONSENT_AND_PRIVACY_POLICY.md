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
