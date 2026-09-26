-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('TELEGRAM', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'DELIVERED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "MessagePriority" AS ENUM ('HIGH', 'NORMAL', 'LOW');

-- CreateTable
CREATE TABLE "message_deliveries" (
    "id" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "userId" TEXT,
    "category" TEXT NOT NULL DEFAULT 'NOTIFICATION',
    "body" TEXT NOT NULL,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "MessagePriority" NOT NULL DEFAULT 'NORMAL',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "metadata" JSONB,
    "fallbackChannel" "MessageChannel",
    "fallbackRecipient" TEXT,
    "fallbackTriggered" BOOLEAN NOT NULL DEFAULT false,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_deliveries_channel_status_idx" ON "message_deliveries"("channel", "status");

-- CreateIndex
CREATE INDEX "message_deliveries_status_nextAttemptAt_idx" ON "message_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "message_deliveries_recipient_idx" ON "message_deliveries"("recipient");

-- CreateIndex
CREATE INDEX "message_deliveries_userId_idx" ON "message_deliveries"("userId");

-- CreateIndex
CREATE INDEX "message_deliveries_createdAt_idx" ON "message_deliveries"("createdAt");
