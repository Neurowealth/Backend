-- Rollback for 20260721130000_add_admin_key_token_prefix
-- Drops the admin key lookup prefix column and its index.
-- WARNING: Reverting restores the broken state in which admin authentication
-- queries a non-existent column and every admin request fails.

DROP INDEX IF EXISTS "admin_api_keys_tokenPrefix_idx";

ALTER TABLE "admin_api_keys" DROP COLUMN IF EXISTS "tokenPrefix";
