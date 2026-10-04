-- Add owner-scoped read-only Stellar links and an opt-in goal flag.
ALTER TABLE "savings_goals"
ADD COLUMN "includeExternalHoldings" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "linked_external_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED_SELF_REPORTED',
    "balances" JSONB,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncAttemptAt" TIMESTAMP(3),
    "syncError" TEXT,

    CONSTRAINT "linked_external_wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "linked_external_wallets_userId_publicKey_key"
ON "linked_external_wallets"("userId", "publicKey");

CREATE INDEX "linked_external_wallets_userId_addedAt_idx"
ON "linked_external_wallets"("userId", "addedAt");

CREATE INDEX "linked_external_wallets_lastSyncAttemptAt_idx"
ON "linked_external_wallets"("lastSyncAttemptAt");

ALTER TABLE "linked_external_wallets"
ADD CONSTRAINT "linked_external_wallets_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;