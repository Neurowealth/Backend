-- Rollback for 20260818120000_add_wallet_encryption_key_registry
-- Reverses the wallet_encryption_keys registry table and the
-- encryptionKeyId provenance column on custodial_wallets.
-- WARNING: Destroys any recorded key-rotation provenance/history.

-- DropForeignKey
ALTER TABLE "custodial_wallets" DROP CONSTRAINT IF EXISTS "custodial_wallets_encryptionKeyId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "custodial_wallets_encryptionKeyId_idx";

-- DropColumn
ALTER TABLE "custodial_wallets" DROP COLUMN IF EXISTS "encryptionKeyId";

-- DropForeignKey
ALTER TABLE "wallet_encryption_keys" DROP CONSTRAINT IF EXISTS "wallet_encryption_keys_rotatedFromId_fkey";

-- DropTable (indexes drop with their table)
DROP TABLE IF EXISTS "wallet_encryption_keys";

-- DropEnum
DROP TYPE IF EXISTS "KeyStatus";
