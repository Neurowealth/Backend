-- Repair schema drift on the admin auth path.
--
-- src/middleware/adminAuth.ts looks admin keys up by "tokenPrefix" (a SHA-256
-- of the raw token) to narrow candidates before the bcrypt compare, and
-- src/routes/admin.ts writes it on key creation — but the column was never
-- added by a migration, so every admin-authenticated request failed with
-- "Unknown argument `tokenPrefix`". (The `db as any` cast in both modules hid
-- this from the type checker.)
--
-- Nullable so the migration is safe on existing rows. Keys created before this
-- migration have no prefix and therefore cannot authenticate — they must be
-- re-issued via POST /api/v1/admin/keys.

-- AlterTable
ALTER TABLE "admin_api_keys" ADD COLUMN "tokenPrefix" TEXT;

-- CreateIndex
CREATE INDEX "admin_api_keys_tokenPrefix_idx" ON "admin_api_keys"("tokenPrefix");
