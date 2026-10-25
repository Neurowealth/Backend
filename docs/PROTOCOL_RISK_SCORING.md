# Protocol Risk Scoring & Transparency

This document is the human-readable companion to the `GET /api/protocols/risk`
endpoint. It defines exactly how each protocol's risk score is computed so that a
user reading the endpoint's factor breakdown can understand *why* a protocol
scored the way it did. An opaque single number would defeat the purpose of a
transparency dashboard, so every input below is surfaced in the API response.

- Scoring math: [`src/agent/riskScoring.ts`](../src/agent/riskScoring.ts) (pure, unit-tested)
- Scheduled job: [`src/jobs/protocolRiskScoring.ts`](../src/jobs/protocolRiskScoring.ts)
- Curated metadata: [`src/config/protocolRiskMetadata.ts`](../src/config/protocolRiskMetadata.ts)
- Data model: `ProtocolRiskScore` in [`prisma/schema.prisma`](../prisma/schema.prisma)

## What the score means

`score` is a normalized integer in **0–100 where higher = lower risk**. It is a
platform-wide methodology: every user is scored against the same formula. A user
cannot redefine the weights (out of scope for v1); they can only set a *risk
ceiling* — a minimum acceptable score — against this shared scale.

The score is recomputed on a schedule (default every 6 hours,
`PROTOCOL_RISK_INTERVAL_MS`) from two sources:

1. **On-chain rate history** already accumulated in `ProtocolRate` — used to
   derive the APY-volatility and TVL-trend factors.
2. **Curated audit/age metadata** — audit status and launch date, which cannot
   be derived from rate history alone. This lives in a single reviewable file
   (see [Curated metadata & review process](#curated-metadata--review-process)).

## The four factors and their weights

The score is a weighted sum of four normalized sub-factors, each in `[0,1]`,
then scaled to 0–100:

| Factor | Weight | Source | Higher value means |
|---|---|---|---|
| Audit status | **0.35** | Curated metadata | Stronger external verification |
| APY volatility | **0.25** | `ProtocolRate` history | More stable yields |
| TVL trend | **0.20** | `ProtocolRate` history | Growing / stable liquidity |
| Protocol age | **0.20** | Curated inception date | Longer track record |

Weights are defined in `WEIGHTS` in `src/agent/riskScoring.ts` and sum to 1.0.
`score = round( clamp01( 0.35·audit + 0.25·volatility + 0.20·tvlTrend + 0.20·age ) · 100 )`.

### Audit status factor

Maps the curated `auditStatus` enum to a factor:

| `auditStatus` | Factor | Operational meaning |
|---|---|---|
| `THIRD_PARTY_AUDITED` | 1.0 | A completed audit by a reputable **external** firm, with a publicly linkable report recorded in the metadata's `auditReference`. |
| `SELF_REPORTED` | 0.5 | The team claims security review/audit but no third-party report is confirmed. |
| `UNAUDITED` | 0.0 | No audit, or status unknown. This is the default for any protocol not present in the curated table. |

### APY volatility factor

Computed from the **standard deviation of `supplyApy`** across the trailing
window (`TRAILING_WINDOW_DAYS`, default 30 days). The factor falls off linearly
from 1.0 at zero stdev to 0.0 at `APY_STDEV_FLOOR` (default 5 percentage points)
and above:

`apyVolatilityFactor = clamp01( 1 − stdev(apy) / APY_STDEV_FLOOR )`

Requires at least 2 usable samples; otherwise it contributes 0 (and the
insufficient-history rule below almost certainly applies anyway).

### TVL trend factor

Computed from the **relative change in TVL** between the first and last
observation in the trailing window. Growth pushes the factor toward 1, decline
toward 0, and flat toward the neutral midpoint 0.5:

`tvlTrendFactor = clamp01( 0.5 + (lastTvl − firstTvl) / firstTvl )`

so a +50% TVL change or more saturates to 1.0 and a −50% change or worse to 0.0.
Samples with null TVL are ignored. If there is no usable TVL data at all, the
factor is the neutral **0.5** — absence of TVL data is not itself a directional
risk signal, and we do not let it masquerade as growth or decline.

### Protocol age factor

Linear credit for track record, from 0 at launch to full credit at
`AGE_SATURATION_DAYS` (default 730 days ≈ 2 years):

`ageFactor = clamp01( protocolAgeDays / AGE_SATURATION_DAYS )`

`protocolAgeDays` is derived at compute time from the curated `inceptionDate`, so
it stays current automatically without manual edits.

## Policy: new protocols (insufficient history)

A protocol needs at least `MIN_SAMPLES_FOR_HISTORY` (default **3**) samples in
the trailing window to have its volatility/trend characterized. Below that
threshold the protocol is **flagged `insufficientHistory: true` and assigned a
conservative fixed score of `INSUFFICIENT_HISTORY_SCORE` (default 20)** rather
than being scored on audit + age alone.

This is deliberate: a brand-new but audited protocol could otherwise post a
misleadingly high score purely from its audit/age credit despite having no
observed track record of stable yields. Scoring it low-and-flagged, instead of
neutral, keeps the number honest. The `insufficientHistory` flag and
`sampleCount` are both exposed in the API so the state is visible, not hidden.

## Policy: data gaps

The rate collector can have downtime, leaving gaps in a protocol's history. Our
policy — matching the concern raised for the backtesting engine in issue #283 —
is:

- **Missing data is treated as absence, never as zero and never as a favorable
  (stable/growing) signal.** We do not fabricate, interpolate, or forward-fill
  values for missing intervals.
- Volatility and trend are computed **only from samples that actually exist** in
  the trailing window.
- The practical consequence: a gap reduces the effective `sampleCount`. If that
  drops the count below `MIN_SAMPLES_FOR_HISTORY`, the protocol falls back to the
  insufficient-history policy above rather than being scored on thin data.

This guarantees a gap can never *inflate* a score (e.g. by making a volatile
protocol look artificially stable) — at worst it makes the score conservative.

## Policy: risk ceiling enforcement (a real safety control)

A user may set an opt-in `riskCeiling` (stored in `User.strategyConfig.riskCeiling`)
— the minimum score a protocol must have to be eligible. This is enforced in
`MaxYieldStrategy` and `TargetAllocationStrategy` **before** any yield/allocation
optimization.

The ceiling limits *which* protocols are eligible; the complementary
**exposure caps** (#346, see
[`REBALANCE_EXPOSURE_COST.md`](REBALANCE_EXPOSURE_COST.md)) limit *how much* of
the portfolio any eligible protocol may hold.

Two guarantees hold, and both are covered by tests:

1. **Backward compatible / opt-in.** When `riskCeiling` is `undefined`, the
   candidate set and every downstream decision are byte-for-byte identical to
   the pre-existing behavior. No score lookup even runs.
2. **Never silently bypassed.** If the ceiling excludes *every* candidate
   protocol, the strategy returns an explicit "no protocols currently meet your
   risk tolerance" decision (`NO_ELIGIBLE_PROTOCOLS_REASON`) and does **not**
   rebalance. The agent never falls back to ignoring the ceiling to have
   somewhere to allocate. Enforcement is also **fail-closed**: a protocol with no
   known score is treated as ineligible under a ceiling, not given the benefit of
   the doubt.

## Curated metadata & review process

> **Update (2026-09-28, #529):** This section originally argued for keeping
> metadata in-code rather than a database ("the code review of a change to
> that file IS the update process"). That design is superseded: metadata now
> lives in the DB-backed `ProtocolRiskMetadataEntry` model, sourced
> (`sourceUrl`), reviewed (`reviewedBy`/`reviewedAt`), and staleness-tracked
> (`nextReviewDueAt`, `dataConfidence`). The gap the original design missed —
> a diff shows WHAT changed, never WHETHER it was verified against a source
> or WHEN it needs re-review — is exactly what #529 closes. See
> `src/config/riskMetadataAdmin.ts` for the admin review workflow and
> `src/jobs/riskMetadataStaleness.ts` for the staleness check.

`auditStatus` and `inceptionDate` are now read from `ProtocolRiskMetadataEntry`
via an in-process cache in
[`src/config/protocolRiskMetadata.ts`](../src/config/protocolRiskMetadata.ts)
(`getProtocolMetadata` stays synchronous — its sole caller, `computeRiskScore`,
is a deliberately pure function — and is populated by `refreshMetadataCache()`
at startup and after every admin write). On-chain data still cannot tell you
whether a protocol was third-party audited or when it launched, so this
remains a human-curated input; only its storage and review trail changed.

Because this metadata goes stale (a protocol gets audited after being marked
`UNAUDITED`, for example), it is reviewed:

1. **On protocol onboarding** — an admin adds an entry when a protocol is
   added to the scanner (`src/agent/scanner.ts`) via the admin review
   endpoint (`risk-metadata:write` scope). A protocol absent from the table
   is scored with the most conservative assumption (`UNAUDITED`,
   unknown/0-day age) — never silently treated as safe.
2. **At or before `nextReviewDueAt`** — a scheduled job
   (`src/jobs/riskMetadataStaleness.ts`) flags entries past their review-due
   date; `sourceUrl` is required for any upgrade to `dataConfidence:
   VERIFIED`, and every change writes an append-only
   `ProtocolRiskMetadataHistory` row.

`inceptionDate` is fixed at launch and should not change once set; age is derived
from it automatically.

> The seed migration (`20260928150000_add_protocol_risk_metadata`) carries
> over the audit statuses that were previously committed as static
> placeholders, all marked `dataConfidence: UNVERIFIED` — honest about the
> fact that they have never actually been reviewed against a source.

## Metadata refresh, staleness alerting and admin updates (#621)

Sourcing expectation: every entry needs an `auditReference`, and `dataConfidence: VERIFIED` needs a
`sourceUrl`. `nextReviewDueAt` is the refresh deadline; re-review each protocol before it passes
(recommended cadence: every 90 days, or immediately after an audit or incident).

- Admin API: `GET /api/v1/admin/risk-metadata` (scope `risk-metadata:read`) and
  `PUT /api/v1/admin/risk-metadata/:protocolName` (scope `risk-metadata:write`). The upsert validates
  input, requires a future `nextReviewDueAt`, and writes the entry, an append-only
  `ProtocolRiskMetadataHistory` row and an `AdminAuditLog` row (`RISK_METADATA_UPSERT`, with
  before/after) in one transaction.
- `src/jobs/riskMetadataStaleness.ts` runs every `PROTOCOL_RISK_STALENESS_INTERVAL_MS` (default 1h).
  When any entry is past `nextReviewDueAt` it sets `risk_metadata_stale_entries` and emits a
  `critical` alert through `src/services/alerting.ts` (PagerDuty when `PAGERDUTY_ROUTING_KEY` is set;
  repeat alerts are rate-limited by the alerting cooldown). Prometheus rule
  `ProtocolRiskMetadataStale` mirrors it.
- Stale protocols are degraded visibly: `GET /api/protocols/risk` returns `riskMetadataStale: true`,
  a `score` reduced by `PROTOCOL_RISK_STALE_SCORE_PENALTY` (default 20, floor 0) and the unmodified
  `rawScore`. Risk-ceiling checks in the rebalancing router use the degraded score.

## Out of scope (v1)

- Automated on-chain audit-status verification — `auditStatus` is curated.
- Per-user custom scoring weights — the formula is platform-wide; users set only
  a threshold against it.
