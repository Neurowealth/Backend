-- rollback.sql — reverse of 20260901000000_add_agent_circuit_breaker/migration.sql
-- Drops the agent circuit breaker table and its enum types (#345).
-- WARNING: DATA LOSS — all breaker state (OPEN/HALF_OPEN), trip details and
-- admin reset audit rows are lost. Revert app code BEFORE running.
-- Indexes are dropped with the table (explicit drops for idempotency).
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260901000000_add_agent_circuit_breaker/rollback.sql

DROP INDEX IF EXISTS "agent_circuit_breakers_state_idx";
DROP INDEX IF EXISTS "agent_circuit_breakers_scope_scopeKey_key";
DROP TABLE IF EXISTS "agent_circuit_breakers" CASCADE;
DROP TYPE IF EXISTS "BreakerState";
DROP TYPE IF EXISTS "BreakerScope";
