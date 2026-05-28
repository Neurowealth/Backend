-- CreateEnum
CREATE TYPE "DeadLetterEventStatus" AS ENUM ('PENDING', 'RETRIED', 'RESOLVED');

-- CreateTable
CREATE TABLE "dead_letter_events" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "error" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeadLetterEventStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dead_letter_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dead_letter_events_status_idx" ON "dead_letter_events"("status");

-- CreateIndex
CREATE INDEX "dead_letter_events_contractId_idx" ON "dead_letter_events"("contractId");

-- CreateIndex
CREATE INDEX "dead_letter_events_txHash_idx" ON "dead_letter_events"("txHash");

-- CreateIndex
CREATE INDEX "dead_letter_events_createdAt_idx" ON "dead_letter_events"("createdAt");
