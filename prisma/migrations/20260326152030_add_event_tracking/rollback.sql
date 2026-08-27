-- rollback.sql — reverse of 20260326152030_add_event_tracking/migration.sql
-- Drops the event_cursors and processed_events tables.

DROP TABLE IF EXISTS "processed_events" CASCADE;
DROP TABLE IF EXISTS "event_cursors" CASCADE;
