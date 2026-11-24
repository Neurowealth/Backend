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

-- A pre-migration row doesn't record which real eventIndex was actually
-- processed (the old key ignored it), so backfilling it to 0 is a label,
-- not a fact. If any ledger at or below this cutover is ever replayed
-- (manual backfill, DLQ retry), handleEvent must keep ignoring eventIndex
-- for it and treat any 4-tuple match as a duplicate — otherwise an event
-- whose real index wasn't 0 would be re-processed as if new, double-
-- crediting/debiting a financial event that already happened.
ALTER TABLE "event_cursors" ADD COLUMN "legacyIdempotencyCutoverLedger" INTEGER;
UPDATE "event_cursors" SET "legacyIdempotencyCutoverLedger" = "lastProcessedLedger";
