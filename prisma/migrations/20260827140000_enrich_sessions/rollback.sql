DROP INDEX IF EXISTS "sessions_revokedAt_idx";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "approxLocation";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "revokedReason";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "revokedAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "lastSeenIp";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "lastSeenAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "deviceType";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "label";
