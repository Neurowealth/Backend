CREATE TYPE "OutboundNotificationStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'RETRYING',
  'DELIVERED',
  'DEAD'
);

CREATE TABLE "outbound_notifications" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboundNotificationStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "providerId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbound_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbound_notifications_status_nextAttemptAt_idx"
  ON "outbound_notifications"("status", "nextAttemptAt");
CREATE INDEX "outbound_notifications_createdAt_idx"
  ON "outbound_notifications"("createdAt");