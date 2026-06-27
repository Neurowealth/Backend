-- Rollback for 20260528_add_dead_letter_events
-- Drops the dead-letter queue table and its enum.
-- WARNING: Destroys any queued/failed events awaiting retry.

DROP TABLE IF EXISTS "dead_letter_events";
DROP TYPE IF EXISTS "DeadLetterEventStatus";
