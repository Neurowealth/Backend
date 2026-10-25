-- rollback.sql — reverse of 20260928121000_add_marketplace_search_index/migration.sql
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260928121000_add_marketplace_search_index/rollback.sql

DROP INDEX IF EXISTS "published_strategies_tags_idx";
DROP INDEX IF EXISTS "published_strategies_description_trgm_idx";
DROP INDEX IF EXISTS "published_strategies_label_trgm_idx";
-- pg_trgm extension is left in place: other objects/migrations may depend on it.
