-- rollback.sql — reverse of 20260928130000_add_treasury_sweep_policy/migration.sql
-- WARNING: DATA LOSS — dropped table loses any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260928130000_add_treasury_sweep_policy/rollback.sql

DROP TABLE IF EXISTS "treasury_sweep_policies";
