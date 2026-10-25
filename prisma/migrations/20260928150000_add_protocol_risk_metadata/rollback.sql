-- rollback.sql — reverse of 20260928150000_add_protocol_risk_metadata/migration.sql
-- WARNING: DATA LOSS — dropped tables lose any data written since the
-- migration was applied (including admin-reviewed metadata updates).
-- Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260928150000_add_protocol_risk_metadata/rollback.sql

DROP TABLE IF EXISTS "protocol_risk_metadata_history";
DROP TABLE IF EXISTS "protocol_risk_metadata_entries";
DROP TYPE IF EXISTS "DataConfidence";
