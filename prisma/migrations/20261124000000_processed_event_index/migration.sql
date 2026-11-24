-- Add event position within its ledger to the idempotency key (#821).
--
-- The dedupe key was (contractId, txHash, eventType, ledger), so two
-- same-type events emitted by one transaction collided and the second was
-- silently treated as an already-processed duplicate. New rows carry the
-- real position parsed from the RPC event id.
ALTER TABLE "processed_events" ADD COLUMN "eventIndex" INTEGER NOT NULL DEFAULT 0;

-- Every row that exists at this point in the migration was written before
-- the eventIndex key existed and never recorded which real index was
-- actually processed — backfilling it to eventIndex=0 above is a label,
-- not a fact. isLegacy marks exactly these rows (every row created after
-- this migration defaults to false). handleEvent treats ANY legacy row
-- matching (contractId, txHash, eventType, ledger) as a duplicate
-- regardless of eventIndex, so replaying a historical range (manual
-- backfill, DLQ retry) can never double-process a financial event whose
-- real index wasn't the backfilled placeholder.
ALTER TABLE "processed_events" ADD COLUMN "isLegacy" BOOLEAN NOT NULL DEFAULT false;
UPDATE "processed_events" SET "isLegacy" = true;

DROP INDEX "processed_events_contractId_txHash_eventType_ledger_key";

CREATE UNIQUE INDEX "processed_events_contractId_txHash_eventType_ledger_eventIndex_key"
  ON "processed_events"("contractId", "txHash", "eventType", "ledger", "eventIndex");
