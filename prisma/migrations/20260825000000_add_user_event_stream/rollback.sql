-- rollback.sql — reverse of 20260825000000_add_user_event_stream/migration.sql
--
-- Drops the user_events stream and its per-user sequence counter.
-- DATA LOSS: replay history for every live WebSocket client is destroyed. A
-- client that reconnects after this runs receives a `gap` frame with
-- currentSeq 0 and must re-fetch a REST snapshot — the documented,
-- already-handled path, but expect a burst of snapshot requests.
-- Safe to run multiple times (IF EXISTS guards).
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260825000000_add_user_event_stream/rollback.sql

-- Drop indexes first (dropped implicitly with the table, listed explicitly for clarity)
DROP INDEX IF EXISTS "user_events_createdAt_idx";
DROP INDEX IF EXISTS "user_events_userId_seq_idx";
DROP INDEX IF EXISTS "user_events_userId_seq_key";

-- Drop the tables (cascade removes foreign-key constraints automatically)
DROP TABLE IF EXISTS "user_events" CASCADE;
DROP TABLE IF EXISTS "user_event_sequences" CASCADE;
