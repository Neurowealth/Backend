-- Migration: add_reserve_sponsorship (#339)
-- Sponsored reserves & trustline lifecycle management.

-- Add new outbox kind for durable, retriable account provisioning
ALTER TYPE "OutboxOpKind" ADD VALUE 'ACCOUNT_PROVISION';

-- Reserve sponsorship ledger: one row per platform-sponsored ledger entry
CREATE TABLE "reserve_sponsorships" (
    "id"             TEXT NOT NULL,
    "sponsoredId"    TEXT NOT NULL,
    "sponsorAccount" TEXT NOT NULL,
    "entryType"      TEXT NOT NULL,
    "ledgerKey"      TEXT NOT NULL,
    "xlmReserved"    DECIMAL(36, 18) NOT NULL,
    "status"         TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"      TIMESTAMP(3),

    CONSTRAINT "reserve_sponsorships_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reserve_sponsorships_sponsoredId_idx" ON "reserve_sponsorships"("sponsoredId");
CREATE INDEX "reserve_sponsorships_sponsorAccount_status_idx" ON "reserve_sponsorships"("sponsorAccount", "status");
