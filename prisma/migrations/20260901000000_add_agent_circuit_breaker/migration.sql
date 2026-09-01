-- Migration: add_agent_circuit_breaker (#345)
-- Agent circuit breaker: a pre-trade kill switch that halts agent-initiated
-- rebalancing at GLOBAL / PROTOCOL / USER scope when abnormal loss, de-peg,
-- oscillation or stale data is detected. Requires an explicit, audited reset.
-- User-initiated withdrawals are never blocked by these rows (enforced in code).

CREATE TYPE "BreakerScope" AS ENUM ('GLOBAL', 'PROTOCOL', 'USER');
CREATE TYPE "BreakerState" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

CREATE TABLE "agent_circuit_breakers" (
    "id"           TEXT NOT NULL,
    "scope"        "BreakerScope" NOT NULL,
    "scopeKey"     TEXT NOT NULL,          -- "" for GLOBAL, protocolName, or userId
    "state"        "BreakerState" NOT NULL DEFAULT 'CLOSED',
    "trippedRule"  TEXT,                   -- abnormal_loss | depeg | oscillation | stale_data | manual
    "trippedAt"    TIMESTAMP(3),
    "detail"       JSONB,
    "resetBy"      TEXT,                   -- admin identity on manual reset
    "resetAt"      TIMESTAMP(3),
    "autoResetAt"  TIMESTAMP(3),           -- earliest time HALF_OPEN is allowed
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_circuit_breakers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_circuit_breakers_scope_scopeKey_key" ON "agent_circuit_breakers"("scope", "scopeKey");
CREATE INDEX "agent_circuit_breakers_state_idx" ON "agent_circuit_breakers"("state");
