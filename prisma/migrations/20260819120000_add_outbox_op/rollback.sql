-- Rollback for 20260819120000_add_outbox_op
-- Drops the durable outbox table and its enums (#325).
--
-- Safe to run before or after deploying the reverted application code: the
-- outbox is additive infrastructure — src/outbox/*, the migrated callers in
-- src/controllers/transaction-controller.ts, src/referral/service.ts, and
-- src/agent/router.ts all import from it, so the application code must be
-- rolled back to the pre-#325 revision FIRST (it will not start with these
-- imports unresolved). Once that revision is deployed, dropping this table
-- loses no confirmed on-chain history: txHash/status/confirmedAt are already
-- mirrored onto the Transaction table by every caller, which is untouched by
-- this migration. Any op still PENDING/SUBMITTED at rollback time represents
-- an in-flight submission that has not been mirrored back yet — drain the
-- queue (or capture it via `SELECT * FROM outbox_ops WHERE status IN
-- ('PENDING','SUBMITTED')`) before rolling back if that matters for your
-- deployment.

DROP TABLE IF EXISTS "outbox_ops";

DROP TYPE IF EXISTS "OutboxOpStatus";

DROP TYPE IF EXISTS "OutboxPriority";

DROP TYPE IF EXISTS "OutboxOpActor";

DROP TYPE IF EXISTS "OutboxOpKind";
