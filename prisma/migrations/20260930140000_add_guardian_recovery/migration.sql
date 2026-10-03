-- #535 Guardian-Based Social Recovery
--
-- Guardian nomination, the per-account recovery policy, the recovery request
-- itself, and the individual guardian approvals. See docs/ACCOUNT_RECOVERY.md
-- for the threat model these tables exist to support.
--
-- Two invariants are enforced HERE rather than only in the service layer,
-- because a database constraint cannot be forgotten by a later edit:
--
--   * required_approvals >= 2  -- a 1-of-N quorum is a single compromised
--     guardian away from a takeover and would make every other control here
--     decorative.
--   * recovery_delay_hours >= 24 -- the cooling-off window is the structural
--     defence against a colluding minority, so it cannot be configured down to
--     nothing.

-- CreateEnum
CREATE TYPE "RecoveryGuardianStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REMOVED');

-- CreateEnum
CREATE TYPE "RecoveryRequestStatus" AS ENUM ('PENDING', 'QUORUM_REACHED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'EXPIRED');

-- CreateTable
CREATE TABLE "recovery_guardians" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guardianUserId" TEXT,
    "externalEmail" TEXT,
    "externalPhone" TEXT,
    "status" "RecoveryGuardianStatus" NOT NULL DEFAULT 'PENDING',
    "inviteTokenHash" TEXT NOT NULL,
    "inviteExpiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_guardians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_policies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 2,
    "recoveryDelayHours" INTEGER NOT NULL DEFAULT 48,
    "maxGuardians" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RecoveryRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "quorumReachedAt" TIMESTAMP(3),
    "executeAfter" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "requiredApprovals" INTEGER,
    "recoveryDelayHours" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_approvals" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "method" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_guardians_inviteTokenHash_key" ON "recovery_guardians"("inviteTokenHash");

-- CreateIndex
CREATE INDEX "recovery_guardians_userId_status_idx" ON "recovery_guardians"("userId", "status");

-- CreateIndex
CREATE INDEX "recovery_guardians_guardianUserId_status_idx" ON "recovery_guardians"("guardianUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_policies_userId_key" ON "recovery_policies"("userId");

-- CreateIndex
CREATE INDEX "recovery_policies_userId_idx" ON "recovery_policies"("userId");

-- CreateIndex
CREATE INDEX "recovery_requests_userId_status_idx" ON "recovery_requests"("userId", "status");

-- CreateIndex
CREATE INDEX "recovery_requests_status_executeAfter_idx" ON "recovery_requests"("status", "executeAfter");

-- One live request per account, enforced by the database.
--
-- The service also checks for an existing live request before creating one, but
-- that read-then-write is racy: two concurrent initiations for the same account
-- would both observe "none" and both insert. Without this index the safety of the
-- flow rests entirely on callers never racing, which a public unauthenticated
-- endpoint cannot guarantee. The index is the actual guarantee.
--
-- Partial rather than a plain unique constraint on userId because a completed,
-- cancelled or expired request must not block the owner from ever recovering
-- again -- and this feature exists precisely for locked-out accounts.
CREATE UNIQUE INDEX "recovery_requests_userId_live_key"
    ON "recovery_requests"("userId")
    WHERE "status" IN ('PENDING', 'QUORUM_REACHED');

-- CreateIndex
CREATE UNIQUE INDEX "recovery_approvals_requestId_guardianId_key" ON "recovery_approvals"("requestId", "guardianId");

-- CreateIndex
CREATE INDEX "recovery_approvals_guardianId_decidedAt_idx" ON "recovery_approvals"("guardianId", "decidedAt");

-- AddForeignKey
ALTER TABLE "recovery_guardians" ADD CONSTRAINT "recovery_guardians_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_guardians" ADD CONSTRAINT "recovery_guardians_guardianUserId_fkey" FOREIGN KEY ("guardianUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_policies" ADD CONSTRAINT "recovery_policies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_approvals" ADD CONSTRAINT "recovery_approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "recovery_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_approvals" ADD CONSTRAINT "recovery_approvals_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "recovery_guardians"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The two non-negotiable invariants. Prisma cannot express CHECK constraints,
-- so they live only here (same precedent as the partial unique index on
-- strategy_follows). verifyPrismaChecksGuard() in
-- tests/unit/guardians/structural.test.ts asserts they are still present.
ALTER TABLE "recovery_policies"
    ADD CONSTRAINT "recovery_policies_required_approvals_check"
    CHECK ("requiredApprovals" >= 2);

ALTER TABLE "recovery_policies"
    ADD CONSTRAINT "recovery_policies_delay_hours_check"
    CHECK ("recoveryDelayHours" >= 24);

ALTER TABLE "recovery_policies"
    ADD CONSTRAINT "recovery_policies_max_guardians_check"
    CHECK ("maxGuardians" >= 2 AND "maxGuardians" <= 20);
