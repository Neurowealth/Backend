-- DropIndex
DROP INDEX "users_walletAddress_idx";

-- DropIndex
DROP INDEX "sessions_token_idx";

-- DropIndex
DROP INDEX "transactions_txHash_idx";

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "sessions_userId_expiresAt_idx" ON "sessions"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "positions_status_idx" ON "positions"("status");

-- CreateIndex
CREATE INDEX "positions_userId_status_idx" ON "positions"("userId", "status");

-- CreateIndex
CREATE INDEX "positions_protocolName_assetSymbol_idx" ON "positions"("protocolName", "assetSymbol");

-- CreateIndex
CREATE INDEX "positions_assetSymbol_idx" ON "positions"("assetSymbol");

-- CreateIndex
CREATE INDEX "transactions_type_idx" ON "transactions"("type");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "transactions_createdAt_idx" ON "transactions"("createdAt");

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_logs_status_idx" ON "agent_logs"("status");

-- CreateIndex
CREATE INDEX "agent_logs_userId_status_idx" ON "agent_logs"("userId", "status");

-- CreateIndex
CREATE INDEX "processed_events_ledger_idx" ON "processed_events"("ledger");
