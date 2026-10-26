# Referral Rewards Program

Single-level referral program: a user shares a code, a new user signs up with
it, and when that new user makes a qualifying on-chain deposit both parties are
rewarded in a platform-funded payout.

The design principle throughout: **rewards are only ever triggered by real,
on-chain-confirmed activity — never by a client-reported claim** — and the
irreversible money-movement step is isolated from the fast DB paths so a
referral problem can never corrupt a deposit or a signup.

## Lifecycle

A referral is one `ReferralConversion` row that moves through these states:

| State | Meaning | Set by |
| --- | --- | --- |
| `PENDING` | Attributed at signup; no deposit yet | `attributeSignup` during `POST /auth/verify` |
| `ACTIVATED` | A confirmed deposit crossed the threshold; a payout is owed | `checkAndActivateOnDeposit`, or an admin approving a `FLAGGED` conversion |
| `FLAGGED` | Deposit crossed the threshold, but the fraud heuristic found a shared IP/device signal — held for manual review, **not** activated | `checkAndActivateOnDeposit`, inside the deposit DB transaction |
| `REWARDED` | Both legs paid on-chain (terminal) | `payoutActivatedConversions` sweep |
| `EXPIRED` | Attribution lapsed without activation, or a `FLAGGED` conversion was rejected on review | `resolveFlaggedConversion` (rejection) |

```
signup w/ code           confirmed deposit ≥ threshold        payout sweep
      │                            │                               │
      ▼                            ▼                               ▼
   PENDING ───────────────────► ACTIVATED ───────────────────► REWARDED
                                   ▲   │
                        approve    │   │ fraud signal found
                                   │   ▼
                                 FLAGGED ────reject────────────► EXPIRED
```

Once a row is `ACTIVATED` it is never un-activated (on-chain finality). A row
stuck at `ACTIVATED` simply means a payout is still owed and will be retried.
A row stuck at `FLAGGED` means it is waiting on an admin decision — see
[Fraud/abuse review](#fraudabuse-review) below.

## Why the steps are split

Activation and payout are deliberately separate:

- **Activation** is a pure DB state change. It runs *inside the same
  transaction that persists the confirmed deposit* (`handleDepositEvent`), so
  attribution and the deposit commit or roll back together. It performs no
  network I/O — no Stellar RPC calls inside the event-listener transaction.
- **Payout** is an irreversible on-chain transfer. It runs in a separate
  periodic sweep (`jobs/referralPayout.ts` → `payoutActivatedConversions`),
  mirroring the fiat on-ramp settlement/reconcile split.

This keeps slow, failure-prone RPC calls off the deposit path and makes payout
independently retriable.

## Attribution (signup)

Attribution happens on `POST /api/v1/auth/verify` via an optional
`referralCode` field, captured atomically with account creation. It is applied
**only when the verify call creates a brand-new user**. Any of these conditions
are ignored silently and never fail signup:

- unknown or malformed code
- self-referral (owner referring their own account)
- the referred user was already attributed (`referredUserId` is unique — one
  referral credit per user, ever)

Codes are 8 chars from an unambiguous alphabet (no `0/O/1/I`), normalised to
uppercase on lookup.

## Activation threshold

Single-deposit policy: **one** confirmed deposit must cross
`REFERRAL_MIN_ACTIVATION_DEPOSIT` on its own. Multiple sub-threshold deposits
do not sum to activation — this is the guard against dust self-referral
farming. Activation pins `activationTxId` to the real, confirmed
`Transaction` that satisfied it.

## Fraud/abuse review

Before a qualifying deposit activates a conversion, `checkAndActivateOnDeposit`
runs `evaluateReferralFraudRisk` (#397): it looks for **IP or device
(user-agent) overlap** between the referrer's and the referred user's
`Session` rows — the signature of one operator signing up multiple accounts
from the same device/network to farm the reward.

This is a heuristic, not a hard block — shared IPs/devices happen legitimately
(family, office, campus wifi), so a hit never blocks the conversion outright.
Instead the conversion is moved to `FLAGGED` (not `ACTIVATED`), with:

- `fraudReasons` — which signal(s) fired (`shared_ip`, `shared_device_fingerprint`)
- `flaggedAt` — when
- `activationTxId` — the deposit that would have activated it, kept for the reviewer

and a `warning` alert is emitted on the `referral-fraud` component.

An admin resolves a `FLAGGED` conversion via `resolveFlaggedConversion`
(`POST /api/admin/referrals/{id}/review`, scope `referrals:write`):

- **approve** → `ACTIVATED` (exactly as if the heuristic hadn't fired; the
  original deposit's `activationTxId` is reused, `activatedAt` set to now)
- **reject** → `EXPIRED` (can never be paid out)

`GET /api/admin/referrals/flagged` (scope `referrals:read`) lists the review
queue, oldest first. `reviewedAt`/`reviewedBy`/`reviewDecision` record the
outcome either way.

## Payout

The sweep scans `ACTIVATED` conversions (oldest first, batched) and pays each
owed leg via `payReferralReward`, which reuses the standard agent-signed
on-chain write path. Each payout is recorded as a distinct
`REFERRAL_REWARD` `Transaction` — separate from user-initiated activity so it
is auditable and identifiable as realized income for tax purposes.

Payout is **idempotent and per-leg**:

- A leg whose `*RewardTxId` is already set is skipped.
- If a leg fails, `payoutError` is recorded, an alert is emitted, and the
  conversion is left `ACTIVATED` (retried next sweep) — it is **not** advanced
  to `REWARDED`.
- Only when every owed leg has a recorded reward tx does the row become
  `REWARDED`.

Setting an owner/referred reward amount to `0` disables that leg.

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/referrals/code` | Bearer | Caller's code (created on first call, idempotent) |
| `GET` | `/api/v1/referrals/{userId}` | Bearer (owner-scoped) | Referrals attributed to the user, newest first |
| `GET` | `/api/admin/referrals/flagged` | Admin (`referrals:read`) | `FLAGGED` conversions awaiting review, oldest first |
| `POST` | `/api/admin/referrals/{id}/review` | Admin (`referrals:write`) | Resolve a `FLAGGED` conversion — body `{ "decision": "approve" \| "reject" }` |

Signup attribution is **not** a route — it is the `referralCode` field on
`POST /api/v1/auth/verify`.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `REFERRAL_MIN_ACTIVATION_DEPOSIT` | `10` | Min single deposit (asset units) to activate |
| `REFERRAL_OWNER_REWARD` | `5` | Reward paid to the referrer (`0` disables) |
| `REFERRAL_REFERRED_REWARD` | `5` | Reward paid to the referred user (`0` disables) |
| `REFERRAL_REWARD_ASSET` | `USDC` | Asset the reward is paid in |
| `REFERRAL_REWARD_CONTRACT_METHOD` | `transfer_reward` | Contract method for the payout call |
| `REFERRAL_PAYOUT_INTERVAL_MS` | `120000` | Interval between payout sweeps |

## Data model

- `ReferralCode` — one per user (`ownerUserId` unique); the shareable `code`.
- `ReferralConversion` — one attribution + its lifecycle. `referredUserId` is
  unique. Holds `activationTxId`, `ownerRewardTxId`, `referredRewardTxId`, and
  `payoutError` for retriable visibility, plus (#397) `fraudReasons`,
  `flaggedAt`, `reviewedAt`, `reviewedBy`, and `reviewDecision` for the
  fraud/abuse review trail.

## Operational notes

- A conversion stuck at `ACTIVATED` with a non-null `payoutError` is a retriable
  payout failure — inspect the message; the sweep will keep retrying.
- Payout failures emit a `warning` alert on the `referral-payout` component
  (deduplicated per conversion + leg).
- Because payouts are agent-signed and platform-funded, ensure the agent
  account is funded for the configured reward asset.

## Fraud review queue and calibration (#619)

Admin endpoints (mounted at `/api/v1/admin/referrals/fraud`):

- `GET /queue` (scope `referrals:read`) lists scored conversions. Filters: `state`
  (`pending` default, `approved`, `rejected`, `all`), `scoreMin`/`scoreMax`, `flag`, `from`/`to`;
  paginated with `page` and `pageSize` (max 100); highest score first.
- `POST /bulk-review` (scope `referrals:write`) body `{ ids, decision: approve|reject, reason }`
  (up to 100 ids; `reason` required for reject). Each conversion is decided and written to
  `AdminAuditLog` (`REFERRAL_BULK_APPROVE`/`REFERRAL_BULK_REJECT`) in its own transaction; ids that
  are unknown or not pending come back in `skipped`.
- `GET /calibration?month=YYYY-MM` (scope `referrals:read`) returns the same report as
  `npx ts-node scripts/referral-calibration.ts [YYYY-MM]`.

Calibration report: score distribution in 20-point bands for conversions created in the month,
and, for conversions reviewed in the month, the false-positive rate
(`approved / reviewed`, since a flagged conversion that a human approves was a false positive) and a
suggested `REFERRAL_FRAUD_REVIEW_SCORE`: the lowest observed score at which rejections make up at
least `REFERRAL_FRAUD_TARGET_PRECISION` (default 0.7) of reviews at or above it.

Threshold and weights are environment-driven, not hard-coded: `REFERRAL_FRAUD_BLOCK_SCORE` (100),
`REFERRAL_FRAUD_REVIEW_SCORE` (80), `REFERRAL_FRAUD_WEIGHT_{DUPLICATE_WALLET,DUPLICATE_EMAIL,
DUPLICATE_PHONE,SAME_IP,VELOCITY,RAPID_ACTIVATION}`, `REFERRAL_FRAUD_VELOCITY_COUNT` (5) and
`REFERRAL_FRAUD_RAPID_ACTIVATION_COUNT` (3). Defaults reproduce the previous behaviour.

## Tiered reward schedule & Sybil abuse detection (#363)

### 1. Tiered reward schedule (`ReferralRewardSchedule`)

Instead of a flat payout on any `$10` deposit, activation resolves a versioned `ReferralRewardSchedule` along two dimensions:

1. **Referred user qualifying deposit tier**:
   - `$10 – $99.99` → `$5` owner / `$5` referred
   - `$100 – $499.99` → `$15` owner / `$10` referred
   - `$500 – $2,499.99` → `$40` owner / `$25` referred
   - `$2,500+` → `$100` owner / `$50` referred
2. **Referrer milestone multiplier** (by lifetime activated referral conversions):
   - `1–4` (`Bronze`) → `1.0x`
   - `5–19` (`Silver`) → `1.25x`
   - `20+` (`Gold`) → `1.5x`

Hard caps:
- `REFERRAL_MAX_REWARD_PER_CONVERSION` (default `$150` per leg)
- `REFERRAL_MAX_REWARD_PER_REFERRER_PER_MONTH` (default `$1,000` per referrer per UTC calendar month)

Every `ReferralConversion` records `scheduleVersion`, `referrerMilestoneTier`, `qualifyingDepositAmount`, `calculatedOwnerReward`, `calculatedReferredReward`, `rewardCapped`, and `capReason` at activation time so subsequent schedule edits never retroactively change in-flight conversions.

### 2. Six Sybil & abuse signals (`src/referral/abuseSignals.ts`)

| Signal code | Default weight | What it detects |
| --- | --- | --- |
| `self_funding_chain` | `50` (`REFERRAL_SYBIL_WEIGHT_SELF_FUNDING`) | Qualifying deposit traces within 1–2 hops or matching transfer memo/amount to a withdrawal from the referrer within `REFERRAL_SELF_FUNDING_WINDOW_HOURS` (72h) |
| `deposit_then_withdraw` | `60` (`REFERRAL_SYBIL_WEIGHT_DEPOSIT_WITHDRAW`) | Referred user withdraws `>= REFERRAL_WITHDRAWAL_HOLD_RATIO` (`80%`) of the qualifying deposit within `REFERRAL_MIN_HOLD_WINDOW_HOURS` (24h) |
| `burst_activations` | `45` (`REFERRAL_SYBIL_WEIGHT_BURST`) | Single referrer triggers `>= REFERRAL_BURST_ACTIVATION_COUNT` (5) activations within `REFERRAL_BURST_WINDOW_MINUTES` (60m) with near-identical or minimum-threshold deposits |
| `shared_fingerprint` | `40` (`REFERRAL_SYBIL_WEIGHT_FINGERPRINT`) | Referrer and referred user share an IP `/24` subnet, normalized device user-agent, or card `paymentMethodRef` |
| `circular_referral` | `85` (`REFERRAL_SYBIL_WEIGHT_CIRCULAR`) | Referral graph contains a cycle of length `<= 3` (`A -> B -> A` or `A -> B -> C -> A`); blocked at `attributeSignup` and scored as high-risk at activation |
| `fresh_wallet_cohort` | `45` (`REFERRAL_SYBIL_WEIGHT_FRESH_COHORT`) | `>= REFERRAL_FRESH_WALLET_CLUSTER_COUNT` (3) referred users under the same referrer created within `REFERRAL_FRESH_WALLET_WINDOW_MINUTES` (10m) of each other |

### 3. Score bands, hold window, and fail-closed invariants

- `score < REFERRAL_HOLD_THRESHOLD` (`< 40`): `payoutHold = NONE`. Conversion waits until `holdUntil = activatedAt + REFERRAL_MIN_HOLD_WINDOW_HOURS` (24h). At payout time `deposit_then_withdraw` is re-evaluated; if `>= 80%` was withdrawn during the hold window, the conversion escalates to `payoutHold = AUTO_REVIEW` with `deposit_then_withdraw` appended and skips payout.
- `40 <= score < 80`: `payoutHold = AUTO_REVIEW`. Shown to the referrer as `PENDING_REVIEW`; held until an admin decides via `POST /api/v1/admin/referrals/review/:id/decision`.
- `score >= REFERRAL_DENY_THRESHOLD` (`>= 80`): `payoutHold = DENIED`. Never paid out; surfaced to the referrer as `NOT_ELIGIBLE` on `GET /api/v1/referrals/me` without exposing internal signal names or scores.
- **Fail-closed**: if the abuse scorer throws during activation, `payoutHold` defaults to `AUTO_REVIEW` (never `NONE`). Furthermore, `payoutActivatedConversions` refuses to pay any conversion whose `abuseRiskScore` is `null` and moves it to `AUTO_REVIEW`.

### 4. Admin review & override

- `GET /api/v1/admin/referrals/review` (`read` scope): lists conversions in `AUTO_REVIEW` with `abuseRiskScore`, `abuseReasons`, `historySummary` (`depositTotal`, `withdrawalTotal`, `netRetained`), and `linkedAccounts`.
- `POST /api/v1/admin/referrals/review/:id/decision` (`write` scope): accepts `{ decision: "RELEASE" | "DENY", reason: string }`, transitions `payoutHold` to `NONE` or `DENIED`, and writes a `#315` `AuditPayloadHash` (`REFERRAL_REVIEW_DECISION`) + `AdminAuditLog` entry.
