-- Rollback for guardian-based social account recovery (#535).
-- This destroys guardian enrollments, pending requests, approvals, and their
-- audit history in the recovery tables. Export them before rollback if needed.

ALTER TABLE "recovery_approvals" DROP CONSTRAINT IF EXISTS "recovery_approvals_guardianId_fkey";
ALTER TABLE "recovery_approvals" DROP CONSTRAINT IF EXISTS "recovery_approvals_requestId_fkey";
ALTER TABLE "account_recovery_requests" DROP CONSTRAINT IF EXISTS "account_recovery_requests_userId_fkey";
ALTER TABLE "account_recovery_requests" DROP CONSTRAINT IF EXISTS "account_recovery_requests_policyId_fkey";
ALTER TABLE "recovery_guardians" DROP CONSTRAINT IF EXISTS "recovery_guardians_guardianUserId_fkey";
ALTER TABLE "recovery_guardians" DROP CONSTRAINT IF EXISTS "recovery_guardians_policyId_fkey";
ALTER TABLE "recovery_policies" DROP CONSTRAINT IF EXISTS "recovery_policies_userId_fkey";

DROP TABLE IF EXISTS "recovery_approvals";
DROP TABLE IF EXISTS "account_recovery_requests";
DROP TABLE IF EXISTS "recovery_guardians";
DROP TABLE IF EXISTS "recovery_policies";

DROP TYPE IF EXISTS "AccountRecoveryStatus";
DROP TYPE IF EXISTS "RecoveryGuardianStatus";
