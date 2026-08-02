-- CreateEnum
CREATE TYPE "TransactionEventType" AS ENUM (
  'INITIATED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'RETRIED', 'REVERSED'
);

-- CreateTable
CREATE TABLE "TransactionEvent" (
  "id"            TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "event"         "TransactionEventType" NOT NULL,
  "metadata"      JSONB,
  "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TransactionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionEvent_transactionId_occurredAt_idx"
  ON "TransactionEvent"("transactionId", "occurredAt");

-- AddForeignKey
ALTER TABLE "TransactionEvent"
  ADD CONSTRAINT "TransactionEvent_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "transactions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: create CONFIRMED events for already-completed transactions
INSERT INTO "TransactionEvent" ("id", "transactionId", "event", "occurredAt")
SELECT gen_random_uuid()::text, id, 'CONFIRMED', "updatedAt"
FROM "transactions"
WHERE status = 'CONFIRMED';