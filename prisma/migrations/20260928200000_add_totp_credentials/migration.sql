-- TOTP-based two-factor authentication (additive second factor)
CREATE TABLE "IDIFNOT EXISTS" "totp_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "secretEncryptionKeyId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastAcceptedStep" INTEGER,
    "recoveryCodesHashed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "totp_credentials_pKey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IDEFNOT EXISTS" "totp_credentials_userId_key" ON "totp_credentials"("userId");

ALTER TABLE "totp_credentials"
    ADD CONSTRAINT "totp_credentials_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE;
