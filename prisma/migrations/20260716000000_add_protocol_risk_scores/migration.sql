-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('UNAUDITED', 'SELF_REPORTED', 'THIRD_PARTY_AUDITED');

-- CreateTable
CREATE TABLE "protocol_risk_scores" (
    "id" TEXT NOT NULL,
    "protocolName" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "tvlTrendFactor" DOUBLE PRECISION NOT NULL,
    "apyVolatilityFactor" DOUBLE PRECISION NOT NULL,
    "auditStatus" "AuditStatus" NOT NULL,
    "protocolAgeDays" INTEGER NOT NULL,
    "insufficientHistory" BOOLEAN NOT NULL DEFAULT false,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_risk_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protocol_risk_scores_protocolName_key" ON "protocol_risk_scores"("protocolName");

-- CreateIndex
CREATE INDEX "protocol_risk_scores_score_idx" ON "protocol_risk_scores"("score");
