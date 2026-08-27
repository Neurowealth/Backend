-- CreateEnum
CREATE TYPE "OutboxOpKind" AS ENUM ('DEPOSIT', 'WITHDRAW', 'REBALANCE', 'RECURRING_DEPOSIT', 'REFERRAL_REWARD', 'YIELD_CLAIM');

-- CreateEnum
CREATE TYPE "OutboxOpActor" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OutboxPriority" AS ENUM ('CRITICAL', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "OutboxOpStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "outbox_ops" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "OutboxOpKind" NOT NULL,
    "actor" "OutboxOpActor" NOT NULL,
    "payload" JSONB NOT NULL,
    "priority" "OutboxPriority" NOT NULL,
    "status" "OutboxOpStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "error" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "signerPublicKey" TEXT,

    CONSTRAINT "outbox_ops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_ops_idempotencyKey_key" ON "outbox_ops"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_ops_txHash_key" ON "outbox_ops"("txHash");

-- CreateIndex
CREATE INDEX "outbox_ops_status_priority_createdAt_idx" ON "outbox_ops"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_ops_userId_idx" ON "outbox_ops"("userId");

-- CreateIndex
CREATE INDEX "outbox_ops_kind_idx" ON "outbox_ops"("kind");

-- CreateIndex
CREATE INDEX "outbox_ops_signerPublicKey_status_idx" ON "outbox_ops"("signerPublicKey", "status");

-- CreateIndex
CREATE INDEX "outbox_ops_status_nextAttemptAt_idx" ON "outbox_ops"("status", "nextAttemptAt");
