# Design: Marketplace Search, Treasury Sweep Policies, Protocol Audit Pipeline, Strategy Ratings+Fees

Closes #527, #528, #529, #526.

## Context

Four issues on Neurowealth/Backend, bundled into one PR. Codebase already has the
scaffolding each issue's "Current State" describes:

- `src/strategy/service.ts` — marketplace publish/follow/unpublish, `marketplaceSelect`
  anonymization boundary (never selects `userId`/`user`).
- `src/stellar/multisig.ts` — in-memory-only `MultisigEnvelope` type, no persistence.
- `prisma/schema.prisma` already has `TreasuryAccount`, `TreasurySweep`,
  `MultisigEnvelope` DB models (migrated in `20260829223002_add_treasury_accounts`)
  but `src/jobs/treasurySweep.ts` is a stub that never reads them.
- `src/config/protocolRiskMetadata.ts` — explicitly documented as a hand-curated,
  code-reviewed, in-repo TS table. `docs/PROTOCOL_RISK_SCORING.md` states: "Do not
  move this data into a database... the code review of a change to that file IS the
  update process." Issue #529 asks for exactly that move — this spec makes the
  override explicit rather than silently ignoring the existing doc's intent.
- `src/approvals/service.ts` — generic co-signer/threshold approval engine
  (`guardOperation`/`decide`), reused rather than rebuilt for treasury's
  `requiresApprovalAbove` gate.
- `src/outbox/` — durable outbox; `OutboxOpKind` has no `TREASURY_SWEEP` member yet
  and `src/outbox/executors.ts` has no case for it. This is the actual integration
  gap for #528 (money movement must go through the outbox — enforced by
  `tests/unit/outbox/structural.test.ts`).

## Shared conventions (all 4 features)

- Prisma: `id String @id @default(uuid())`, `@@map(snake_case)`, `Decimal(36,18)` for
  token amounts, `createdAt/updatedAt` timestamps, composite `@@index` matching query
  patterns, FK `onDelete: Cascade` for owned child rows.
- Service layer: exported functions take an optional `database?: Db` param
  (`Db = typeof db | Prisma.TransactionClient`) for transaction composition, matching
  `src/approvals/service.ts` and `src/strategy/service.ts`.
- Admin routes: `requireAdminAuth` then `requireAdminScope('<domain>:<action>')`;
  new scope strings added to `ADMIN_SCOPES` in `src/middleware/adminAuth.ts`.
- Response shape: `{success:true, data, timestamp}` / `{success:false, error}` to
  match existing route conventions (not the newer `ErrorResponse` contract, since
  neighboring strategy/approval routes still use the ad hoc envelope).
- Migrations: `prisma/migrations/<YYYYMMDDHHMMSS>_<desc>/migration.sql`.
- Structural tests, one per boundary that must never be crossed (mirroring
  `tests/unit/outbox/structural.test.ts` and the strategy-follow import-graph test).

## #527 — Marketplace Discovery, Search & Category Tagging

**Data model**
- `PublishedStrategy` gains `tags String[] @default([])` and `description String?`
  (short, length-capped like `label`).
- New `MarketplaceTag` table: admin-curated vocabulary (`slug` unique, `label`,
  `isActive`). `tags` on `PublishedStrategy` stores slugs; publish validator checks
  every supplied tag exists and `isActive` in `MarketplaceTag` — no free-form tags.
- No new facet-storage table: facets (risk band, strategy type, protocols touched)
  are derived live via pure functions over `strategyConfig`/`StrategyFollow`
  aggregates, same "derived, never stale" requirement the issue calls out.

**API**
- Extend `marketplaceQuerySchema` (`src/validators/strategy-validators.ts`) with
  `riskMax?`, `protocols?` (CSV), `type?`, `tags?` (CSV), `q?`.
- `getMarketplace` in `src/strategy/service.ts` gains filter clauses; text search
  (`q`) against `label`/`description` via `ILIKE` (Postgres `pg_trgm` index added in
  the same migration as the schema change, for scale per the issue's "no
  Elasticsearch" scope note).
- Facet counts: a second, cheap aggregate query (`groupBy` on the derived facet
  dimensions) run against the *unfiltered eligible set*, returned alongside results
  always — including on an empty filtered result — per the "relax your filters" UX
  requirement.
- Preserve `marketplaceSelect`'s no-`userId` contract; `tags`/`description` are
  additive fields to that allowlist, not a bypass of it.

## #528 — Treasury Sweep Policies, Emergency Sweep Path & Signer Rotation

**Data model**
- New `TreasurySweepPolicy`: `fromTier TreasuryTier`, `toTier TreasuryTier`,
  `maxHotBalance Decimal`, `sweepIntervalMinutes Int`, `minSweepAmount Decimal`,
  `requiresApprovalAbove Decimal?`, `version Int`, `isActive Boolean`,
  `createdAt/createdBy`. Versioned by insert-new-row-and-deactivate-old, never
  mutated in place — a change is an auditable new row.
- New `SignerRotation`: `treasuryAccountId`, `oldSignerKey`, `newSignerKey`,
  `status ROTATION_PENDING|DUAL_ACTIVE|FINALIZED|CANCELLED`, `approvals` (reuses
  `ApprovalRequest`/`Approval` machinery scoped to a new `SIGNER_ROTATION`
  permission-like action), `dualActiveSince`, `finalizedAt`.
- `MultisigEnvelope` (already in schema) gains `signerSetVersion Int` so an envelope
  created before a rotation finalizes keeps validating against the signer set that
  was active when it was opened — never silently invalidated mid-collection.

**Sweep engine**
- `src/jobs/treasurySweep.ts` stub is replaced: `evaluateTreasuryBalances` reads
  `TreasuryAccount` + active `TreasurySweepPolicy` per tier pair, returns
  `SweepPlan[]` using policy thresholds (not the current stub's always-`[]`).
  `validateHysteresis` and the config-validation rules (hot cap < warm cap, etc.)
  run at policy-write time, rejecting invalid policies with a specific error.
- `executeSweep` enqueues via `enqueueOutboxOp` with a new `OutboxOpKind =
  'TREASURY_SWEEP'`; add the matching `OutboxPayload` variant and a case in
  `src/outbox/executors.ts` (the only two files allowed to touch raw Stellar writes
  — structural test updated to allow-list this new payload kind).
- Sweeps above `requiresApprovalAbove` call `guardOperation` from
  `src/approvals/service.ts` before enqueueing (reusing the existing co-signer
  engine rather than a parallel approval path, per the issue's explicit ask).
- Emergency sweep: a separate `executeEmergencySweep` — always full multisig
  threshold (never reads `TreasurySweepPolicy.requiresApprovalAbove`, always
  requires 100% of configured signers), triggered by admin action or the agent
  circuit breaker's manual-trip path, writes its own audit rows (reusing the
  existing `AuditBlock`/`AuditPayloadHash` hash-chain already in schema — same
  integrity bar as other money movement).
- Concurrency: sweep execution claims via the same `signerPublicKey`-scoped
  serialization the outbox dispatcher already does (`src/outbox/signerLock.ts`) so
  emergency and cadence sweeps on the same signer can't race.

**Signer rotation**
- Rotation request → dual-active window (both old and new key valid for signing)
  → threshold-gated finalize (existing signers approve via `ApprovalRequest`-style
  flow) → old key removed. In-flight `MultisigEnvelope`s pinned to
  `signerSetVersion` complete under their original signer set regardless of a
  rotation finalizing mid-collection.
- All policy changes and rotation events write `AdminAuditLog` rows (or a
  treasury-specific audit table if volume warrants — reusing `AdminAuditLog`
  is the default per existing precedent).

**Docs**: new `docs/TREASURY.md` — policy model, rotation procedure, emergency-sweep
runbook entry.

## #529 — Sourced, Reviewable Protocol Audit-Status Data Pipeline

This explicitly supersedes the design note in `docs/PROTOCOL_RISK_SCORING.md`
("do not move this into a database"). Justification: the issue's whole point is that
curator-entered, unsourced data silently drives fund-allocation risk logic with no
review trail — a code-reviewed TS file gives *diff* history but no *source URL*,
*reviewer*, or *staleness* signal, which is what's actually missing. The DB move is
adopted; `docs/PROTOCOL_RISK_SCORING.md` gets an update noting the supersession.

**Data model**
- New `ProtocolRiskMetadataEntry`: `protocolName @unique`, `auditStatus
  AuditStatus` (reuse existing enum), `auditReference String` (now required),
  `sourceUrl String?`, `reviewedAt/reviewedBy`, `nextReviewDueAt`, `dataConfidence
  VERIFIED|SELF_REPORTED|UNVERIFIED`, `inceptionDate`.
- New `ProtocolRiskMetadataHistory` (append-only) for the "disputed status change is
  auditable" requirement — one row per update, written alongside the entry update in
  the same transaction.
- Seed migration inserts today's 3 static `PROTOCOL_RISK_METADATA` entries verbatim,
  all `dataConfidence: UNVERIFIED`, `nextReviewDueAt: now()`. A regression test
  diffs the seeded rows against the static array's current values so the migration
  can't silently drift from what's live today.

**Code changes**
- `src/config/protocolRiskMetadata.ts`'s `getProtocolMetadata`/
  `computeProtocolAgeDays` become thin wrappers over a DB read with an in-process
  cache (TTL, invalidated on admin write) — same shape callers already use, so
  `src/jobs/protocolRiskScoring.ts` needs no changes beyond the import.
- Missing entry (protocol scanned but never curated): treated as maximally
  conservative — same fail-closed contract `applyRiskCeiling` already uses for
  unscored protocols, extended to unmetadata'd ones.
- Admin CRUD (`admin:read`/`treasury` style scope, e.g. `risk-metadata:write`):
  `sourceUrl` required to set `dataConfidence: VERIFIED`.
- New cron (`scheduleResilientJob`, same pattern as `protocolRiskScoring.ts`) flags
  entries past `nextReviewDueAt`; a config toggle
  (`config.protocolRisk.staleAutoDowngrade`) optionally downgrades
  `dataConfidence` toward `UNVERIFIED` on staleness, default off (flag-only).

## #526 — Strategy Marketplace: Ratings, Reviews & Creator Performance Fee

**Data model**
- New `StrategyRating`: `publishedStrategyId`, `followerUserId`, `stars Int(1-5)`,
  `reviewText String?`, `createdAt/updatedAt`. `@@unique([publishedStrategyId,
  followerUserId])` — edit-in-place via upsert. Write path checks
  `StrategyFollow.followedAt <= now() - MIN_FOLLOW_DAYS` before allowing a rating
  (config constant, e.g. 14 days).
- New `PublishedStrategyRatingAggregate` (one row per strategy, precomputed):
  `avgRating`, `recencyWeightedScore`, `ratingCount` — same rationale as
  `PublishedStrategyMetric` (can't `ORDER BY` a JS-computed value, and recomputing
  per request is a DoS vector on a semi-public endpoint). Recomputed by a job
  alongside `strategyMetrics.ts`'s existing cadence.
- `PublishedStrategy` gains `performanceFeeBps Int?` (nullable = no fee, capped
  `<= 2000` at the validator).
- `StrategyFollow` gains `consentedFeeBps Int?` and `consentedFeeAt DateTime?` —
  captured at follow time from the strategy's *current* `performanceFeeBps`. A
  later fee change on the strategy does not touch existing follows'
  `consentedFeeBps`; only a follower's own re-follow (or an explicit re-consent
  endpoint) updates it.

**Fee settlement**
- Reuses `StrategyAttribution`/yield-attribution output for "positive attributable
  yield during active-follow periods" — no parallel yield-accounting path.
- New `OutboxOpKind = 'CREATOR_FEE_PAYOUT'` (mirrors `REFERRAL_REWARD`'s pattern:
  `NORMAL` priority, `actor: 'SYSTEM'`), settled via the existing outbox dispatcher.
  Zero fee on a losing period — never negative, never clawed back.

**API**
- `POST /:id/rate` (auth, `MIN_FOLLOW_DAYS` gate, rate-limited per user per day —
  reuses the existing rate-limiter middleware pattern with a new named limiter).
- Marketplace listing/sort gains `rating` as a `MarketplaceSortField` option;
  strategies below a configurable minimum rating (with a minimum sample count) are
  flagged in the response, not excluded — distinct from the #527 eligibility gate
  which does exclude.
- Unpublishing a strategy preserves `StrategyRating` rows (no cascade delete on
  unpublish, only on account deletion per existing `onDelete: Cascade` precedent).

**Docs**: `docs/STRATEGY_MARKETPLACE.md` updated with tags/search (#527) and
ratings/fee (#526) sections.

## Testing

- Unit tests per new service module, mirroring `tests/unit/<domain>/<module>.test.ts`.
- Integration tests for: marketplace search+facets, treasury sweep policy
  read-through, signer rotation dual-active-window, rating gate + aggregate
  recompute, fee settlement zero-on-loss.
- Structural tests: outbox payload allow-list update (#528, #526 new kinds), any new
  import-boundary assertions analogous to the strategy-follow custody test.
- Regression test: `ProtocolRiskMetadataEntry` seed matches today's static array
  exactly (#529).

## Out of scope (per issue text)

Personalized recommendations, Elasticsearch, HSM integration, cross-chain treasury,
dispute/appeal process for reviews, multi-tier creator monetization, automated
third-party audit-status scraping.
