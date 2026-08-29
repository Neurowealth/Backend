-- Rollback for 20260824153458_add_approval_workflows
-- Drops the approval-workflow tables (#314).
-- WARNING: Destroys every ApprovalPolicy/ApprovalRequest/Approval row —
-- any currently-open PENDING_APPROVAL operation's intent is lost, not just
-- deferred. Deploy the reverted application code BEFORE running this: the
-- live code calls guardOperation on every deposit/withdraw, so dropping
-- these tables underneath a running server breaks that gate.

ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_requestId_fkey";
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_userId_fkey";
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_policyId_fkey";
ALTER TABLE "approval_policies" DROP CONSTRAINT IF EXISTS "approval_policies_principalUserId_fkey";

DROP TABLE IF EXISTS "approvals";
DROP TABLE IF EXISTS "approval_requests";
DROP TABLE IF EXISTS "approval_policies";

DROP TYPE IF EXISTS "ApprovalStatus";
