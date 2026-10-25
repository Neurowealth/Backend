# Treasury Sweep Policies & Signer Rotation

## Policy model

`TreasurySweepPolicy` governs one tier pair (e.g. HOT→WARM). Policies are
versioned: a change never mutates an existing row — `createPolicyVersion`
(`src/treasury/policy.ts`) deactivates the current active policy and inserts
a new one in the same transaction, so every policy change is an auditable
new version. Validated at write time: `fromTier !== toTier`,
`sweepIntervalMinutes > 0`, `0 < minSweepAmount < maxHotBalance`,
`requiresApprovalAbove <= maxHotBalance`.

## Sweep cadence

`src/jobs/treasurySweep.ts`'s `evaluateTreasuryBalances` reads each active
`TreasuryAccount` and its tier pair's active policy, and plans a sweep when
the on-chain balance exceeds `maxHotBalance` by more than `minSweepAmount`.
`executeSweep` gates on `requiresApprovalAbove`: sweeps above the threshold
open a `MultisigEnvelope` (the treasury's own multisig primitive,
`src/stellar/multisig.ts`) instead of enqueueing immediately — an admin
collects signatures before a follow-up submission enqueues the outbox op.
Sweeps at or below the threshold enqueue a `TREASURY_SWEEP` outbox op
directly via `src/outbox/service.ts`.

## Emergency sweep

`executeEmergencySweep` bypasses cadence but never the signing bar — it
never reads `requiresApprovalAbove` and always submits at `CRITICAL`
priority. Triggered by an admin (`POST /api/admin/treasury/emergency-sweep`,
scope `treasury:write`) or the agent circuit breaker's manual-trip path.
Writes a distinct `AdminAuditLog` row (`action:
'treasury.emergency_sweep'`) separate from a normal sweep's audit trail.

## Signer rotation runbook

1. `POST /api/admin/treasury/signer-rotations` with `treasuryAccountId`,
   `oldSignerKey`, `newSignerKey` — enters `DUAL_ACTIVE` immediately; both
   keys are valid signers from this point. Both keys are validated with
   `StrKey.isValidEd25519PublicKey` before the row is written; a typo or
   non-`G...` value is rejected with `400` (#671).
2. Any `MultisigEnvelope` opened before this point keeps validating against
   the signer set active when it opened (`signerSetVersion`) — a rotation
   never invalidates an in-flight envelope.
3. `POST /api/admin/treasury/signer-rotations/:id/finalize` — only valid
   from `DUAL_ACTIVE`; transitions to `FINALIZED`. The persisted
   `newSignerKey` is validated again before it is copied to
   `TreasuryAccount.publicKey`, so a legacy/bad row can never become the
   signer that `resolveSignerPublicKey` uses for sweeps. New envelopes opened
   after this point require the new key.

## Concurrency

Emergency and cadence sweeps on the same signer account never race: op
submission is claimed and serialized per `signerPublicKey` by the existing
outbox dispatcher (`src/outbox/signerLock.ts`), the same mechanism every
other money-moving outbox op already relies on.

## Sweep preview and enablement runbook (#620)

New policy versions start with `sweepsEnabled = false`: the cadence job ignores them and
`executeSweep` refuses to run. Creating a new version therefore pauses sweeps for that tier pair
until an operator re-enables it.

1. `POST /api/admin/treasury/policies` creates the new policy version (scope `treasury:write`).
2. `POST /api/admin/treasury/sweep/preview` (scope `treasury:read`) returns every sweep the active
   policies would plan, with `policyEnabled` and `requiresApproval` per item. It reads balances but
   creates no `TreasurySweep`, `MultisigEnvelope` or outbox op, so nothing is sent to the chain.
3. Review the plans. Then `POST /api/admin/treasury/policies/:id/enable` with
   `{ "confirmation": "SWEEP" }` (scope `treasury:write`). Any other text is rejected. The enable is
   recorded with `enabledBy`/`enabledAt` and in the admin audit log.
4. Only after step 3 does the cadence job plan sweeps and enqueue `TREASURY_SWEEP` outbox ops.
5. A failed sweep emits a `critical` alert on component `treasury-sweep` (PagerDuty/Slack when
   configured) and rethrows. Emergency sweeps are unaffected by `sweepsEnabled`.

Existing active policies also default to disabled after migration `20261020090000`; enable each one
after previewing.
