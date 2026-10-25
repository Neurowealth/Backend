-- rollback.sql — reverse of 20260829223003_add_liquidity_snapshots/migration.sql
-- Drops the ProtocolLiquiditySnapshot table.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260829223003_add_liquidity_snapshots/rollback.sql

DROP TABLE IF EXISTS "protocol_liquidity_snapshots";
