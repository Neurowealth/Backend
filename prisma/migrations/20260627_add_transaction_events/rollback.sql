-- Rollback for 20260627_add_transaction_events
-- Drops the TransactionEvent table and its enum.
-- The forward migration's CONFIRMED-event backfill is removed along with the
-- table, so no separate cleanup is required.
-- WARNING: Destroys the transaction event-sourcing audit trail.

ALTER TABLE "TransactionEvent" DROP CONSTRAINT IF EXISTS "TransactionEvent_transactionId_fkey";

DROP TABLE IF EXISTS "TransactionEvent";

DROP TYPE IF EXISTS "TransactionEventType";
