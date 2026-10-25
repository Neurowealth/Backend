CREATE TABLE "webauthn_credentials" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "credentialId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL, "signCount" BIGINT NOT NULL DEFAULT 0,
  "deviceLabel" TEXT, "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webauthn_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "webauthn_credentials_credentialId_key" ON "webauthn_credentials"("credentialId");
CREATE INDEX "webauthn_credentials_userId_idx" ON "webauthn_credentials"("userId");
CREATE INDEX "webauthn_credentials_credentialId_idx" ON "webauthn_credentials"("credentialId");
CREATE TABLE "webauthn_challenges" (
  "id" TEXT NOT NULL, "challenge" TEXT NOT NULL, "purpose" TEXT NOT NULL,
  "userId" TEXT, "sessionId" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "webauthn_challenges_challenge_key" ON "webauthn_challenges"("challenge");
CREATE INDEX "webauthn_challenges_expiresAt_idx" ON "webauthn_challenges"("expiresAt");
