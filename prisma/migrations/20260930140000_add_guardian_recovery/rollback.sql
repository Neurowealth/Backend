-- Rollback for 20260930140000_add_guardian_recovery (#535).
--
-- Fully reversible: the feature owns all four tables exclusively, so dropping
-- them restores the pre-migration schema. No pre-existing table is altered, so
-- nothing else can be collateral damage.
--
-- One consequence to accept before rolling back: any recovery history recorded
-- under #535 is destroyed with these tables. That is the correct behaviour for a
-- rollback of a security feature (an operator running the down migration is
-- explicitly choosing to remove the mechanism), but it is irreversible in the
-- data sense, so export `recovery_approvals` first if the audit trail matters.

-- Explicit, though redundant: dropping a table takes its indexes with it. Named
-- so the one-live-request invariant is visibly reversed here rather than only
-- implicitly. `recovery_requests_userId_live_key` is the partial unique index
-- that made concurrent initiation impossible.
DROP INDEX IF EXISTS "recovery_requests_userId_live_key";
DROP INDEX IF EXISTS "recovery_approvals_guardianId_decidedAt_idx";
DROP INDEX IF EXISTS "recovery_approvals_requestId_guardianId_key";
DROP INDEX IF EXISTS "recovery_requests_status_executeAfter_idx";
DROP INDEX IF EXISTS "recovery_requests_userId_status_idx";
DROP INDEX IF EXISTS "recovery_policies_userId_idx";
DROP INDEX IF EXISTS "recovery_policies_userId_key";
DROP INDEX IF EXISTS "recovery_guardians_guardianUserId_status_idx";
DROP INDEX IF EXISTS "recovery_guardians_userId_status_idx";
DROP INDEX IF EXISTS "recovery_guardians_inviteTokenHash_key";

DROP TABLE IF EXISTS "recovery_approvals";
DROP TABLE IF EXISTS "recovery_requests";
DROP TABLE IF EXISTS "recovery_policies";
DROP TABLE IF EXISTS "recovery_guardians";

DROP TYPE IF EXISTS "RecoveryRequestStatus";
DROP TYPE IF EXISTS "RecoveryGuardianStatus";
