CREATE TYPE "DataConfidence" AS ENUM ('VERIFIED', 'SELF_REPORTED', 'UNVERIFIED');

CREATE TABLE "protocol_risk_metadata_entries" (
  "id" TEXT NOT NULL,
  "protocolName" TEXT NOT NULL,
  "auditStatus" "AuditStatus" NOT NULL,
  "auditReference" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "nextReviewDueAt" TIMESTAMP(3) NOT NULL,
  "dataConfidence" "DataConfidence" NOT NULL DEFAULT 'UNVERIFIED',
  "inceptionDate" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "protocol_risk_metadata_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "protocol_risk_metadata_entries_protocolName_key" ON "protocol_risk_metadata_entries"("protocolName");
CREATE INDEX "protocol_risk_metadata_entries_nextReviewDueAt_idx" ON "protocol_risk_metadata_entries"("nextReviewDueAt");

CREATE TABLE "protocol_risk_metadata_history" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "auditStatus" "AuditStatus" NOT NULL,
  "dataConfidence" "DataConfidence" NOT NULL,
  "sourceUrl" TEXT,
  "changedBy" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "protocol_risk_metadata_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "protocol_risk_metadata_history_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "protocol_risk_metadata_entries"("id") ON DELETE CASCADE
);
CREATE INDEX "protocol_risk_metadata_history_entryId_idx" ON "protocol_risk_metadata_history"("entryId");

-- Seed: reproduces today's PROTOCOL_RISK_METADATA static array exactly
-- (src/config/protocolRiskMetadata.ts), all marked UNVERIFIED — honest about
-- the fact that this data has never actually been verified against a source.
INSERT INTO "protocol_risk_metadata_entries"
  ("id", "protocolName", "auditStatus", "auditReference", "nextReviewDueAt", "dataConfidence", "inceptionDate", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'Blend', 'THIRD_PARTY_AUDITED', 'https://docs.blend.capital/ — verify latest audit report on review', CURRENT_TIMESTAMP, 'UNVERIFIED', '2024-02-01'::timestamp, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Stellar DEX', 'THIRD_PARTY_AUDITED', 'Stellar Core protocol; native DEX. Verify scope on review.', CURRENT_TIMESTAMP, 'UNVERIFIED', '2015-09-30'::timestamp, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Luma', 'SELF_REPORTED', 'Self-reported; no third-party audit confirmed at time of curation.', CURRENT_TIMESTAMP, 'UNVERIFIED', '2023-06-01'::timestamp, CURRENT_TIMESTAMP);
