-- TOTP-based two-factor authentication (additive second factor)
CREATE TABLE IF NOT EXISTS "totp_credentials" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "totp_credentials_userId_key" ON "totp_credentials"("userId");

-- Add foreign key constraint (no IF NOT EXISTS support in older PostgreSQL)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'totp_credentials_userId_fkey'
    ) THEN
        ALTER TABLE "totp_credentials"
            ADD CONSTRAINT "totp_credentials_userId_fkey" FOREIGN KEY ("userId")
            REFERENCES "users"("id") ON DELETE CASCADE;
    END IF;
END $$;
