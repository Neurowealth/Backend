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
| `ACTIVATED` | A confirmed deposit crossed the threshold; a payout is owed | `checkAndActivateOnDeposit`, inside the deposit DB transaction |
| `REWARDED` | Both legs paid on-chain (terminal) | `payoutActivatedConversions` sweep |
| `EXPIRED` | Attribution lapsed without activation (reserved) | — |

```
signup w/ code           confirmed deposit ≥ threshold        payout sweep
      │                            │                               │
      ▼                            ▼                               ▼
   PENDING ───────────────────► ACTIVATED ───────────────────► REWARDED
```

Once a row is `ACTIVATED` it is never un-activated (on-chain finality). A row
stuck at `ACTIVATED` simply means a payout is still owed and will be retried.

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
  `payoutError` for retriable visibility.

## Operational notes

- A conversion stuck at `ACTIVATED` with a non-null `payoutError` is a retriable
  payout failure — inspect the message; the sweep will keep retrying.
- Payout failures emit a `warning` alert on the `referral-payout` component
  (deduplicated per conversion + leg).
- Because payouts are agent-signed and platform-funded, ensure the agent
  account is funded for the configured reward asset.
