-- DropIndex
DROP INDEX "dead_letter_events_status_createdAt_idx";

-- AlterTable
ALTER TABLE "custodial_wallets" ADD COLUMN     "keyVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "admin_api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scopes" TEXT[],
    "hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "admin_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "adminKeyId" TEXT,
    "adminName" TEXT,
    "adminRole" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "result" TEXT NOT NULL,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "method" TEXT,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_api_keys_name_key" ON "admin_api_keys"("name");

-- CreateIndex
CREATE INDEX "admin_api_keys_role_idx" ON "admin_api_keys"("role");

-- CreateIndex
CREATE INDEX "admin_api_keys_revokedAt_idx" ON "admin_api_keys"("revokedAt");

-- CreateIndex
CREATE INDEX "admin_api_keys_expiresAt_idx" ON "admin_api_keys"("expiresAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_adminKeyId_idx" ON "admin_audit_logs"("adminKeyId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_idx" ON "admin_audit_logs"("action");

-- CreateIndex
CREATE INDEX "admin_audit_logs_result_idx" ON "admin_audit_logs"("result");

-- CreateIndex
CREATE INDEX "admin_audit_logs_createdAt_idx" ON "admin_audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "custodial_wallets_keyVersion_idx" ON "custodial_wallets"("keyVersion");

-- CreateIndex
CREATE INDEX "protocol_rates_protocolName_assetSymbol_fetchedAt_idx" ON "protocol_rates"("protocolName", "assetSymbol", "fetchedAt");

-- CreateIndex
CREATE INDEX "yield_snapshots_positionId_snapshotAt_idx" ON "yield_snapshots"("positionId", "snapshotAt");

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_adminKeyId_fkey" FOREIGN KEY ("adminKeyId") REFERENCES "admin_api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
