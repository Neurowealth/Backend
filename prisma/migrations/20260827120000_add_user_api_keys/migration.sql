-- CreateTable
CREATE TABLE "user_api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "hash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rateLimitPerMin" INTEGER,
    "allowWithdrawals" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_api_keys_userId_idx" ON "user_api_keys"("userId");

-- CreateIndex
CREATE INDEX "user_api_keys_tokenPrefix_idx" ON "user_api_keys"("tokenPrefix");

-- AddForeignKey
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
