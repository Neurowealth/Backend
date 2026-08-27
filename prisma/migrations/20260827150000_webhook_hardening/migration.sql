ALTER TABLE "webhook_subscriptions" ADD COLUMN "secretNext" TEXT;
ALTER TABLE "webhook_subscriptions" ADD COLUMN "secretNextActiveAt" TIMESTAMP(3);
ALTER TABLE "webhook_subscriptions" ADD COLUMN "autoReplay" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "webhook_dead_letters" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_dead_letters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_dead_letters_subscriptionId_status_idx" ON "webhook_dead_letters"("subscriptionId", "status");

ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "webhook_dead_letters_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
