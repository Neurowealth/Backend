-- Add new transaction types for claimable balance ingestion
ALTER TYPE "TransactionType" ADD VALUE 'INBOUND_TRANSFER';
ALTER TYPE "TransactionType" ADD VALUE 'CLAIMABLE_BALANCE_CLAIM';

-- Create InboundOperation table for idempotency
CREATE TABLE "inbound_operations" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "operationIndex" INTEGER NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "asset" TEXT NOT NULL,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inbound_operations_txHash_operationIndex_key" UNIQUE ("txHash", "operationIndex")
);

-- Create indexes
CREATE INDEX "inbound_operations_account_idx" ON "inbound_operations"("account");
CREATE INDEX "inbound_operations_isProcessed_idx" ON "inbound_operations"("isProcessed");

-- Create InboundCursor table for per-account ledger tracking
CREATE TABLE "inbound_cursors" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL UNIQUE,
    "lastLedger" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_cursors_pkey" PRIMARY KEY ("id")
);
