-- CreateEnum
CREATE TYPE "SubAccountPermission" AS ENUM ('VIEW', 'DEPOSIT', 'WITHDRAW', 'MANAGE_STRATEGY');

-- CreateEnum
CREATE TYPE "SubAccountStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable: Add actingAsUserId to Transaction
ALTER TABLE "transactions" ADD COLUMN "actingAsUserId" TEXT;

-- AlterTable: Add actingAsUserId to AgentLog
ALTER TABLE "agent_logs" ADD COLUMN "actingAsUserId" TEXT;

-- CreateTable
CREATE TABLE "sub_accounts" (
    "id" TEXT NOT NULL,
    "parentUserId" TEXT NOT NULL,
    "childUserId" TEXT NOT NULL,
    "permissions" "SubAccountPermission"[] NOT NULL,
    "status" "SubAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sub_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sub_accounts_parentUserId_childUserId_key" ON "sub_accounts"("parentUserId", "childUserId");

-- CreateIndex
CREATE INDEX "sub_accounts_parentUserId_idx" ON "sub_accounts"("parentUserId");

-- CreateIndex
CREATE INDEX "sub_accounts_childUserId_idx" ON "sub_accounts"("childUserId");

-- CreateIndex
CREATE INDEX "sub_accounts_status_idx" ON "sub_accounts"("status");

-- CreateIndex
CREATE INDEX "transactions_actingAsUserId_idx" ON "transactions"("actingAsUserId");

-- CreateIndex
CREATE INDEX "agent_logs_actingAsUserId_idx" ON "agent_logs"("actingAsUserId");

-- AddForeignKey
ALTER TABLE "sub_accounts" ADD CONSTRAINT "sub_accounts_parentUserId_fkey" FOREIGN KEY ("parentUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_accounts" ADD CONSTRAINT "sub_accounts_childUserId_fkey" FOREIGN KEY ("childUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
