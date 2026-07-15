-- Rollback for 20260326152030_add_event_tracking
-- Drops the event-tracking tables (indexes drop with their table).
-- WARNING: Destroys event cursor state and the processed-event dedupe log.

DROP TABLE IF EXISTS "processed_events";
DROP TABLE IF EXISTS "event_cursors";
