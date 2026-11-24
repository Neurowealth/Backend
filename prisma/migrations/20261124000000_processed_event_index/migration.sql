-- Add event position within its ledger to the idempotency key (#821).
--
-- The dedupe key was (contractId, txHash, eventType, ledger), so two
-- same-type events emitted by one transaction collided and the second was
-- silently treated as an already-processed duplicate. Existing rows get
-- eventIndex=0 (they were recorded one-per-row already, so this is a safe
-- backfill), and new rows carry the real position parsed from the RPC
-- event id.
ALTER TABLE "processed_events" ADD COLUMN "eventIndex" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "processed_events_contractId_txHash_eventType_ledger_key";

CREATE UNIQUE INDEX "processed_events_contractId_txHash_eventType_ledger_eventIndex_key"
  ON "processed_events"("contractId", "txHash", "eventType", "ledger", "eventIndex");
