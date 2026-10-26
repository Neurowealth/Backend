# Fiat Transaction Limits, Velocity Controls & KYC-Tier Enforcement (#362)

This document describes the platform-side fiat transaction limits, rolling velocity controls, and KYC-tier enforcement engine (`src/fiat/limits.ts`).

---

## 1. KYC Tiers & Default Policy Table

Every user has a `KycProfile` (`userId`, `tier`, `providerRef`, `verifiedAt`, `reviewNote`) defaulting to `TIER_0` until verified by a signed provider callback or an audited admin override.

| Tier     | Per-Txn Max (On-Ramp / Off-Ramp) | Rolling 24h Daily Max (On-Ramp / Off-Ramp) | Rolling 30d Monthly Max (On-Ramp / Off-Ramp) | Max Txns / 1h (On-Ramp / Off-Ramp) | Max Txns / 24h (On-Ramp / Off-Ramp) | Base Currency |
| :------- | :------------------------------- | :----------------------------------------- | :------------------------------------------- | :--------------------------------- | :---------------------------------- | :------------ |
| `TIER_0` | $0 / $0                          | $0 / $0                                    | $0 / $0                                      | 0 / 0                              | 0 / 0                               | `USD`         |
| `TIER_1` | $1,000 / $500                    | $2,500 / $1,000                            | $10,000 / $5,000                             | 3 / 2                              | 10 / 5                              | `USD`         |
| `TIER_2` | $10,000 / $5,000                 | $25,000 / $15,000                          | $100,000 / $50,000                           | 5 / 4                              | 20 / 10                             | `USD`         |
| `TIER_3` | $50,000 / $25,000                | $100,000 / $50,000                         | $500,000 / $250,000                          | 10 / 6                             | 50 / 25                             | `USD`         |

Operators can inspect and tune these limits at runtime via `GET /api/v1/admin/fiat/limit-policies` and `PUT /api/v1/admin/fiat/limit-policies` (persisted in `fiat_limit_policies` and recorded in `admin_audit_logs`).

---

## 2. Evaluation Order & Invariants (`evaluateFiatOrder`)

Every path that creates a `FiatOrder` — manual `POST /api/v1/fiat/orders`, scheduled fiat purchase jobs, and scheduled fiat payout jobs — calls `evaluateFiatOrder` first. Checks run in deterministic priority order:

1. **Compliance Freeze (`compliance_freeze`)**:
   - Checked **before** any tier or limit calculation. If the user is inactive (`User.isActive === false`) or has an active `#321` `ComplianceCase` (`OPEN`, `TRIAGE`, `INVESTIGATING`, `ESCALATED`, `PENDING_SAR`), the order is denied immediately with `reason: 'compliance_freeze'`.
2. **Tier Zero (`tier_zero`)**:
   - Unverified (`TIER_0`) accounts have $0 caps and are denied with `reason: 'tier_zero'`.
3. **FX Conversion to Base Currency (`fx_unavailable`)**:
   - Policy caps are denominated in `policy.currency` (default `USD`). Cross-currency orders are converted via the FX feed (`rateSource: 'FX_FEED'`, never assumed `1.0`).
   - If the FX feed is down or a currency pair cannot be priced, cross-currency checks **fail closed** (`reason: 'fx_unavailable'`).
4. **Per-Transaction Cap (`per_txn`)**:
   - Denies orders where `baseAmount > perTxnMax`.
5. **Rolling 1-Hour Velocity (`velocity_hourly`)**:
   - Counts counting orders in `(now - 1h, now]`. Denies when `count + 1 > maxTxnsPerHour` and returns `retryAfter` (seconds until the oldest order in the 1h window ages out).
6. **Rolling 24-Hour Velocity (`velocity_daily`)**:
   - Counts counting orders in `(now - 24h, now]`. Denies when `count + 1 > maxTxnsPerDay`.
7. **Rolling 24-Hour Volume (`daily`)**:
   - Sums base-currency volume in `(now - 24h, now]`. Denies when `used + baseAmount > dailyMax`.
8. **Rolling Monthly Volume (`monthly`)**:
   - Sums base-currency volume in the rolling 30-day window (or UTC calendar month when configured). Denies when `used + baseAmount > monthlyMax`.

---

## 3. Pending-Order Headroom & Refund / Failure Release Semantics

- **Pending Headroom Reservation**:
  - Orders in `PENDING`, `PROCESSING`, and `SETTLED` states all reserve headroom immediately upon creation (`createdAt`). A burst of concurrent order creations cannot bypass velocity or volume caps before provider webhooks arrive.
- **Headroom Release on `FAILED` / `REFUNDED`**:
  - When a `PENDING` order transitions to `FAILED` (provider webhook or stale-order age-out), or a `SETTLED` order transitions to `REFUNDED`, its headroom is released **as of the failure/refund timestamp** (`refundedAt ?? updatedAt`), and `fiat_limit_headroom_released_total` is incremented.
  - Historical windows prior to `refundedAt` are **never** retroactively rewritten: point-in-time evaluations at `t < refundedAt` still reflect the headroom that was reserved at time `t`, while evaluations at `t >= refundedAt` see the released headroom.

---

## 4. Soft Warnings & Scheduled Plan Auto-Pause

- **Soft Warning (`fiat.limit.approaching`)**:
  - When an allowed order pushes any window's utilization above `LIMIT_SOFT_WARN_PCT` (default `0.80` / 80%), the order succeeds, attaches `limitWarning` (`{ window, utilizationPct, used, limit, remaining, currency }`) to the response, and emits `fiat.limit.approaching` on the `alerts` stream topic and webhook channel.
- **Scheduled Plan Auto-Pause (`evaluateScheduledFiatRun`)**:
  - When a scheduled fiat purchase or payout run is denied by `evaluateFiatOrder`, it records a `skipped_limit` outcome and increments `consecutiveSkippedLimit`.
  - After `FIAT_SCHEDULED_SKIP_AUTO_PAUSE_THRESHOLD` (default `3`) consecutive `skipped_limit` runs, the plan automatically transitions to `PAUSED` (`shouldAutoPause: true`) and logs an alert rather than silently no-op'ing indefinitely.

---

## 5. API Endpoints

- `GET /api/v1/fiat/limits` — Returns the authenticated caller's `tier`, `currency`, and `{ limit, used, remaining, nextResetAt }` for `perTxn`, `daily`, `monthly`, `velocityHourly`, and `velocityDaily`.
- `POST /api/v1/kyc/verify` — Initiates the provider-hosted KYC verification session. Rejects any client-supplied `tier`.
- `POST /api/v1/kyc/webhook/:provider` — Signature-verified provider callback that updates `KycProfile.tier` and `KycProfile.providerRef` (opaque token only; no PII stored).
- `GET /api/v1/admin/fiat/limit-policies` & `PUT /api/v1/admin/fiat/limit-policies` — Admin inspection and tuning of per-tier policies (`fiat:read` / `fiat:write`, audited).
- `POST /api/v1/admin/users/:id/kyc-tier` — Manual KYC tier override requiring a non-empty `reviewNote` (`fiat:write`, audited).
