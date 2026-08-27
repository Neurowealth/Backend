-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" TEXT NOT NULL,
    "principalUserId" TEXT NOT NULL,
    "scopedToChildUserId" TEXT,
    "permission" "SubAccountPermission" NOT NULL,
    "minApprovers" INTEGER NOT NULL,
    "highValueThreshold" DECIMAL(36,18),
    "approvalTimeoutMs" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actingAsUserId" TEXT NOT NULL,
    "permission" "SubAccountPermission" NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "minApprovers" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "executedTxId" TEXT,
    "cancelledById" TEXT,
    "reason" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_policies_principalUserId_permission_isActive_idx" ON "approval_policies"("principalUserId", "permission", "isActive");

-- CreateIndex
CREATE INDEX "approval_policies_scopedToChildUserId_permission_isActive_idx" ON "approval_policies"("scopedToChildUserId", "permission", "isActive");

-- CreateIndex
CREATE INDEX "approval_requests_userId_status_idx" ON "approval_requests"("userId", "status");

-- CreateIndex
CREATE INDEX "approval_requests_status_expiresAt_idx" ON "approval_requests"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "approvals_requestId_idx" ON "approvals"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_requestId_approverUserId_key" ON "approvals"("requestId", "approverUserId");

-- AddForeignKey
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_principalUserId_fkey" FOREIGN KEY ("principalUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "approval_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
