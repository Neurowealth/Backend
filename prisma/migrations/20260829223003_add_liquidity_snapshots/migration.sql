-- Create ProtocolLiquiditySnapshot table for liquidity risk analysis
CREATE TABLE "protocol_liquidity_snapshots" (
    "id" TEXT NOT NULL,
    "protocolName" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "poolTvl" DECIMAL(36,18) NOT NULL,
    "availableLiquidity" DECIMAL(36,18) NOT NULL,
    "dailyVolume" DECIMAL(36,18) NOT NULL,
    "withdrawalQueueDepth" INTEGER,
    "depthCurve" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_liquidity_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "protocol_liquidity_snapshots_protocolName_assetSymbol_fetchedAt_key" UNIQUE ("protocolName", "assetSymbol", "fetchedAt")
);

-- Create indexes
CREATE INDEX "protocol_liquidity_snapshots_protocolName_assetSymbol_idx" ON "protocol_liquidity_snapshots"("protocolName", "assetSymbol");
CREATE INDEX "protocol_liquidity_snapshots_fetchedAt_idx" ON "protocol_liquidity_snapshots"("fetchedAt");
