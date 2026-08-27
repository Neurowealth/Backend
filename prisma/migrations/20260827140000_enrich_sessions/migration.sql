ALTER TABLE "sessions" ADD COLUMN "label" TEXT;
ALTER TABLE "sessions" ADD COLUMN "deviceType" TEXT;
ALTER TABLE "sessions" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN "lastSeenIp" TEXT;
ALTER TABLE "sessions" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN "revokedReason" TEXT;
ALTER TABLE "sessions" ADD COLUMN "approxLocation" TEXT;
CREATE INDEX "sessions_revokedAt_idx" ON "sessions"("revokedAt");
