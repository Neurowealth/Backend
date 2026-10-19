CREATE TYPE "RecoveryRequestStatus" AS ENUM ('PENDING', 'CANCELLED', 'REJECTED', 'COMPLETED');

ALTER TABLE "users" ADD COLUMN "authPublicKey" TEXT;
UPDATE "users" SET "authPublicKey" = "walletAddress";
ALTER TABLE "users" ALTER COLUMN "authPublicKey" SET NOT NULL;
CREATE UNIQUE INDEX "users_authPublicKey_key" ON "users"("authPublicKey");

CREATE TABLE "recovery_policies" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "ownerUserId" TEXT NOT NULL,
  "requiredApprovals" INTEGER NOT NULL DEFAULT 2,
  "recoveryDelayHours" INTEGER NOT NULL DEFAULT 72,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recovery_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_policies_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "recovery_policies_quorum_check" CHECK ("requiredApprovals" BETWEEN 2 AND 5),
  CONSTRAINT "recovery_policies_delay_check" CHECK ("recoveryDelayHours" = 72)
);
CREATE UNIQUE INDEX "recovery_policies_ownerUserId_key"
  ON "recovery_policies"("ownerUserId");

CREATE TABLE "recovery_guardians" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "ownerUserId" TEXT NOT NULL,
  "guardianUserId" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recovery_guardians_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_guardians_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "recovery_guardians_guardianUserId_fkey"
    FOREIGN KEY ("guardianUserId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "recovery_guardians_not_self_check" CHECK ("ownerUserId" <> "guardianUserId")
);
CREATE UNIQUE INDEX "recovery_guardians_ownerUserId_guardianUserId_key"
  ON "recovery_guardians"("ownerUserId", "guardianUserId");
CREATE INDEX "recovery_guardians_guardianUserId_acceptedAt_idx"
  ON "recovery_guardians"("guardianUserId", "acceptedAt");

CREATE TABLE "recovery_requests" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "ownerUserId" TEXT NOT NULL,
  "proposedAuthPublicKey" TEXT NOT NULL,
  "status" "RecoveryRequestStatus" NOT NULL DEFAULT 'PENDING',
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "quorumReachedAt" TIMESTAMP(3),
  "completesAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancellationTokenHash" TEXT,
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "recovery_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_requests_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "recovery_requests_one_pending_per_owner"
  ON "recovery_requests"("ownerUserId") WHERE "status" = 'PENDING';
CREATE INDEX "recovery_requests_ownerUserId_status_idx"
  ON "recovery_requests"("ownerUserId", "status");
CREATE INDEX "recovery_requests_status_completesAt_idx"
  ON "recovery_requests"("status", "completesAt");

CREATE TABLE "recovery_approvals" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "requestId" TEXT NOT NULL,
  "guardianId" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recovery_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_approvals_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "recovery_requests"("id") ON DELETE CASCADE,
  CONSTRAINT "recovery_approvals_guardianId_fkey"
    FOREIGN KEY ("guardianId") REFERENCES "recovery_guardians"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "recovery_approvals_requestId_guardianId_key"
  ON "recovery_approvals"("requestId", "guardianId");
CREATE INDEX "recovery_approvals_guardianId_idx"
  ON "recovery_approvals"("guardianId");
