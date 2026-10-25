-- Migration: harden_session_refresh_tokens (#472)
-- Makes the refresh-token lifecycle enforceable: a deterministic lookup key so
-- rotation no longer bcrypt-scans every live session, a used-at marker so a
-- replayed token can be detected, and a rotation counter for diagnostics.
-- Class A (metadata only): nullable columns and one index, so this is
-- non-blocking and safe to ship in a rolling deploy.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "refreshTokenPrefix" TEXT;
ALTER TABLE "sessions" ADD COLUMN "refreshTokenUsedAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN "refreshTokenRotations" INTEGER NOT NULL DEFAULT 0;

-- Lookup key for refresh rotation. Rows without a prefix are pre-#472 sessions
-- whose refresh token can no longer be verified; their clients re-authenticate.
CREATE INDEX "sessions_refreshTokenPrefix_idx" ON "sessions"("refreshTokenPrefix");
