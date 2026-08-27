-- rollback.sql — reverse of 20260302221454_init/migration.sql
-- Drops all tables created by the initial schema migration.
-- WARNING: This is a full database wipe. Only run in a non-production
-- environment or after a verified database snapshot backup.

-- Drop foreign keys and tables in dependency order
DROP TABLE IF EXISTS "agent_logs" CASCADE;
DROP TABLE IF EXISTS "yield_snapshots" CASCADE;
DROP TABLE IF EXISTS "transactions" CASCADE;
DROP TABLE IF EXISTS "protocol_rates" CASCADE;
DROP TABLE IF EXISTS "positions" CASCADE;
DROP TABLE IF EXISTS "sessions" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;
