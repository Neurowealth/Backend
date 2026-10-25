-- rollback.sql — reverse of 20260827130000_add_idempotency_records/migration.sql
-- Drops the idempotency_records table.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260827130000_add_idempotency_records/rollback.sql

DROP TABLE IF EXISTS "idempotency_records";
