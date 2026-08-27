-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('ACTIVE', 'RETIRED', 'COMPROMISED');

-- CreateTable
CREATE TABLE "wallet_encryption_keys" (
    "id" TEXT NOT NULL,
    "keyLabel" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "status" "KeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "rotatedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "wallet_encryption_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_encryption_keys_keyLabel_key" ON "wallet_encryption_keys"("keyLabel");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_encryption_keys_hash_key" ON "wallet_encryption_keys"("hash");

-- CreateIndex
CREATE INDEX "wallet_encryption_keys_status_idx" ON "wallet_encryption_keys"("status");

-- AddForeignKey
ALTER TABLE "wallet_encryption_keys" ADD CONSTRAINT "wallet_encryption_keys_rotatedFromId_fkey" FOREIGN KEY ("rotatedFromId") REFERENCES "wallet_encryption_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "custodial_wallets" ADD COLUMN "encryptionKeyId" TEXT;

-- CreateIndex
CREATE INDEX "custodial_wallets_encryptionKeyId_idx" ON "custodial_wallets"("encryptionKeyId");

-- AddForeignKey
ALTER TABLE "custodial_wallets" ADD CONSTRAINT "custodial_wallets_encryptionKeyId_fkey" FOREIGN KEY ("encryptionKeyId") REFERENCES "wallet_encryption_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
