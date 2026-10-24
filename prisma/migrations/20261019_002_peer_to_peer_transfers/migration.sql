-- #546 Peer-to-peer transfers. Transfers reassign existing position ownership;
-- they never mint a balance or submit an on-chain operation.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'INTERNAL_TRANSFER';

ALTER TABLE "transactions" ADD COLUMN "internalTransferId" TEXT;

CREATE TABLE "internal_transfers" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
    "senderUserId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "senderHandle" TEXT NOT NULL,
    "recipientHandle" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "note" VARCHAR(280),
    "riskScore" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "internal_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "internal_transfers_positive_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "internal_transfers_distinct_users_check" CHECK ("senderUserId" <> "recipientUserId"),
    CONSTRAINT "internal_transfers_senderUserId_fkey"
      FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "internal_transfers_recipientUserId_fkey"
      FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_internalTransferId_fkey"
  FOREIGN KEY ("internalTransferId") REFERENCES "internal_transfers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "transactions_internalTransferId_idx"
  ON "transactions"("internalTransferId");
CREATE INDEX "internal_transfers_senderUserId_createdAt_idx"
  ON "internal_transfers"("senderUserId", "createdAt");
CREATE INDEX "internal_transfers_recipientUserId_createdAt_idx"
  ON "internal_transfers"("recipientUserId", "createdAt");
CREATE INDEX "internal_transfers_senderUserId_recipientHandle_idx"
  ON "internal_transfers"("senderUserId", "recipientHandle");
