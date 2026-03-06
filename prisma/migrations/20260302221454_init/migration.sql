-- CreateEnum
CREATE TYPE "Network" AS ENUM ('MAINNET', 'TESTNET', 'FUTURENET');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'YIELD_CLAIM', 'REBALANCE', 'SWAP');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('ACTIVE', 'CLOSED', 'LIQUIDATED');

-- CreateEnum
CREATE TYPE "AgentAction" AS ENUM ('DEPOSIT', 'WITHDRAW', 'REBALANCE', 'ANALYZE', 'ALERT', 'CLAIM_YIELD');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "network" "Network" NOT NULL DEFAULT 'MAINNET',
    "displayName" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "riskTolerance" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "protocolName" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "assetAddress" TEXT,
    "depositedAmount" DECIMAL(36,18) NOT NULL,
    "currentValue" DECIMAL(36,18) NOT NULL,
    "yieldEarned" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'ACTIVE',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT,
    "txHash" TEXT,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "assetSymbol" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "fee" DECIMAL(36,18),
    "network" "Network" NOT NULL,
    "protocolName" TEXT,
    "memo" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "yield_snapshots" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "apy" DECIMAL(10,6) NOT NULL,
    "yieldAmount" DECIMAL(36,18) NOT NULL,
    "principalAmount" DECIMAL(36,18) NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "yield_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocol_rates" (
    "id" TEXT NOT NULL,
    "protocolName" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "supplyApy" DECIMAL(10,6) NOT NULL,
    "borrowApy" DECIMAL(10,6),
    "tvl" DECIMAL(36,2),
    "network" "Network" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "AgentAction" NOT NULL,
    "status" "AgentStatus" NOT NULL,
    "reasoning" TEXT,
    "inputData" JSONB,
    "outputData" JSONB,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_walletAddress_idx" ON "users"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_token_idx" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "positions_userId_idx" ON "positions"("userId");

-- CreateIndex
CREATE INDEX "positions_protocolName_idx" ON "positions"("protocolName");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_txHash_key" ON "transactions"("txHash");

-- CreateIndex
CREATE INDEX "transactions_userId_idx" ON "transactions"("userId");

-- CreateIndex
CREATE INDEX "transactions_txHash_idx" ON "transactions"("txHash");

-- CreateIndex
CREATE INDEX "transactions_positionId_idx" ON "transactions"("positionId");

-- CreateIndex
CREATE INDEX "yield_snapshots_positionId_idx" ON "yield_snapshots"("positionId");

-- CreateIndex
CREATE INDEX "yield_snapshots_snapshotAt_idx" ON "yield_snapshots"("snapshotAt");

-- CreateIndex
CREATE INDEX "protocol_rates_protocolName_assetSymbol_idx" ON "protocol_rates"("protocolName", "assetSymbol");

-- CreateIndex
CREATE INDEX "protocol_rates_fetchedAt_idx" ON "protocol_rates"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "protocol_rates_protocolName_assetSymbol_network_fetchedAt_key" ON "protocol_rates"("protocolName", "assetSymbol", "network", "fetchedAt");

-- CreateIndex
CREATE INDEX "agent_logs_userId_idx" ON "agent_logs"("userId");

-- CreateIndex
CREATE INDEX "agent_logs_action_idx" ON "agent_logs"("action");

-- CreateIndex
CREATE INDEX "agent_logs_createdAt_idx" ON "agent_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "yield_snapshots" ADD CONSTRAINT "yield_snapshots_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
