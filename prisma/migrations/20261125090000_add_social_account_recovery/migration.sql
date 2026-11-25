CREATE TYPE "RecoveryGuardianStatus" AS ENUM (
    'PENDING',
    'ACCEPTED',
    'DECLINED',
    'REMOVED'
);

CREATE TYPE "AccountRecoveryStatus" AS ENUM (
    'PENDING',
    'COOLING_OFF',
    'COMPLETED',
    'CANCELLED',
    'EXPIRED',
    'FAILED'
);

CREATE TABLE "recovery_policies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requiredApprovals" INTEGER NOT NULL CHECK ("requiredApprovals" >= 2),
    "recoveryDelayHours" INTEGER NOT NULL DEFAULT 72 CHECK ("recoveryDelayHours" = 72),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "recovery_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recovery_guardians" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "guardianUserId" TEXT NOT NULL,
    "status" "RecoveryGuardianStatus" NOT NULL DEFAULT 'PENDING',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "recovery_guardians_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account_recovery_requests" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentWalletAddress" TEXT NOT NULL,
    "newWalletAddress" TEXT NOT NULL,
    "status" "AccountRecoveryStatus" NOT NULL DEFAULT 'PENDING',
    "requiredApprovals" INTEGER NOT NULL CHECK ("requiredApprovals" >= 2),
    "recoveryDelayHours" INTEGER NOT NULL DEFAULT 72 CHECK ("recoveryDelayHours" = 72),
    "quorumReachedAt" TIMESTAMP(3),
    "completesAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelTokenHash" TEXT,
    "cancelTokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "account_recovery_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recovery_approvals" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recovery_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recovery_policies_userId_key" ON "recovery_policies"("userId");
CREATE UNIQUE INDEX "recovery_guardians_policyId_guardianUserId_key" ON "recovery_guardians"("policyId", "guardianUserId");
CREATE INDEX "recovery_guardians_guardianUserId_status_idx" ON "recovery_guardians"("guardianUserId", "status");
CREATE INDEX "account_recovery_requests_userId_status_idx" ON "account_recovery_requests"("userId", "status");
CREATE INDEX "account_recovery_requests_status_completesAt_idx" ON "account_recovery_requests"("status", "completesAt");
CREATE INDEX "account_recovery_requests_expiresAt_idx" ON "account_recovery_requests"("expiresAt");
CREATE INDEX "account_recovery_requests_cancelTokenHash_idx" ON "account_recovery_requests"("cancelTokenHash");
CREATE UNIQUE INDEX "account_recovery_requests_one_active_per_user_idx"
    ON "account_recovery_requests"("userId")
    WHERE "status" IN ('PENDING', 'COOLING_OFF');
CREATE UNIQUE INDEX "recovery_approvals_requestId_guardianId_key" ON "recovery_approvals"("requestId", "guardianId");
CREATE INDEX "recovery_approvals_guardianId_idx" ON "recovery_approvals"("guardianId");

ALTER TABLE "recovery_policies" ADD CONSTRAINT "recovery_policies_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recovery_guardians" ADD CONSTRAINT "recovery_guardians_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "recovery_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recovery_guardians" ADD CONSTRAINT "recovery_guardians_guardianUserId_fkey"
    FOREIGN KEY ("guardianUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "recovery_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recovery_approvals" ADD CONSTRAINT "recovery_approvals_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "account_recovery_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recovery_approvals" ADD CONSTRAINT "recovery_approvals_guardianId_fkey"
    FOREIGN KEY ("guardianId") REFERENCES "recovery_guardians"("id") ON DELETE CASCADE ON UPDATE CASCADE;
