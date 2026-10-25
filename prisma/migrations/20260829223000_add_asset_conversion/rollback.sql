-- rollback.sql — reverse of 20260829223000_add_asset_conversion/migration.sql
-- Drops the AssetConversion table.
-- WARNING: DATA LOSS — dropped columns/tables lose any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260829223000_add_asset_conversion/rollback.sql

DROP TABLE IF EXISTS "asset_conversions";
