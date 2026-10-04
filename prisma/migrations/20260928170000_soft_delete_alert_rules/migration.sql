-- Reversible alert-rule soft deletion and user-scoped lifecycle audit.
ALTER TABLE "alert_rules" ADD COLUMN "deletedAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "alert_rules_userId_idx";
CREATE INDEX "alert_rules_userId_deletedAt_idx"
ON "alert_rules"("userId", "deletedAt");

CREATE TABLE "user_data_audits" (
    "id" TEXT NOT NULL,
    "tenantUserId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_data_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_data_audits_tenantUserId_createdAt_idx"
ON "user_data_audits"("tenantUserId", "createdAt");

CREATE INDEX "user_data_audits_recordType_recordId_idx"
ON "user_data_audits"("recordType", "recordId");