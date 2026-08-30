-- Create AssetConversion table for path-payment routing audit trail
CREATE TABLE "asset_conversions" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT UNIQUE,
    "sourceAsset" TEXT NOT NULL,
    "sourceAmount" DECIMAL(36,18) NOT NULL,
    "destAsset" TEXT NOT NULL,
    "destAmount" DECIMAL(36,18) NOT NULL,
    "quotedDestAmount" DECIMAL(36,18) NOT NULL,
    "realizedSlippageBps" INTEGER NOT NULL,
    "path" JSONB NOT NULL,
    "rpcSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_conversions_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "asset_conversions_transactionId_idx" ON "asset_conversions"("transactionId");
