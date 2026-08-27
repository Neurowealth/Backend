-- CreateTable
CREATE TABLE "allocation_suggestions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "weights" JSONB NOT NULL,
    "frontier" JSONB NOT NULL,
    "backtestSummary" JSONB,
    "riskTolerance" INTEGER NOT NULL,
    "effectiveRiskCeiling" INTEGER,
    "reason" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocation_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "allocation_suggestions_userId_computedAt_idx" ON "allocation_suggestions"("userId", "computedAt");

-- CreateIndex
CREATE INDEX "allocation_suggestions_userId_inputHash_idx" ON "allocation_suggestions"("userId", "inputHash");

-- AddForeignKey
ALTER TABLE "allocation_suggestions" ADD CONSTRAINT "allocation_suggestions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
