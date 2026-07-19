-- Rollback for 20260717500000_add_session_refresh_tokens (#214).
-- WARNING: Drops stored refresh-token hashes; all issued refresh tokens become
-- unusable and clients must re-authenticate.

ALTER TABLE "sessions" DROP COLUMN IF EXISTS "refreshTokenExpiresAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "refreshTokenHash";
