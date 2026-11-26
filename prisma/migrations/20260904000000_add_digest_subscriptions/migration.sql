-- Cross-Channel Digest Notifications (#365)
-- Opt-in DAILY/WEEKLY/MONTHLY portfolio summaries delivered over a user's
-- chosen channels (WHATSAPP/TELEGRAM/EMAIL/WEBHOOK) by src/jobs/digests.ts.
--
-- `channels` is a Postgres array of the DigestChannel enum. `quietHours` is a
-- JSONB object { startUtc, endUtc } (UTC 0..23); `sendHourUtc` defaults to 9
-- (09:00 UTC) and `nextRunAt` is populated by the API with the very next
-- occurrence so the job has something to claim immediately.

-- CreateEnum
CREATE TYPE "DigestFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "DigestChannel" AS ENUM ('WHATSAPP', 'TELEGRAM', 'EMAIL', 'WEBHOOK');

-- CreateTable
CREATE TABLE "digest_subscriptions" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "frequency"    "DigestFrequency" NOT NULL,
    "channels"     "DigestChannel"[] NOT NULL,
    "sendHourUtc"  INTEGER NOT NULL DEFAULT 9,
    "weeklyDayUtc" INTEGER,
    "quietHours"   JSONB,
    "isActive"     BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt"   TIMESTAMP(3),
    "nextRunAt"    TIMESTAMP(3) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "digest_subscriptions_pkey" PRIMARY KEY ("id")
);

-- The job's tick claims rows via "WHERE id = ? AND isActive = true AND
-- nextRunAt <= now", so the composite index mirrors that predicate.
CREATE INDEX "digest_subscriptions_isActive_nextRunAt_idx"
    ON "digest_subscriptions"("isActive", "nextRunAt");

CREATE INDEX "digest_subscriptions_userId_idx"
    ON "digest_subscriptions"("userId");

ALTER TABLE "digest_subscriptions"
    ADD CONSTRAINT "digest_subscriptions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
