-- #214 – refresh token rotation. Adds hashed refresh-token storage to sessions.
-- The refresh token itself is never stored in plaintext; only its bcrypt hash
-- is persisted, alongside an independent expiry from the access token.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "refreshTokenHash" TEXT;
ALTER TABLE "sessions" ADD COLUMN "refreshTokenExpiresAt" TIMESTAMP(3);
