-- rollback.sql — reverse of 20260528_add_dead_letter_events/migration.sql
-- Drops the dead_letter_events table and the DeadLetterEventStatus enum.

DROP TABLE IF EXISTS "dead_letter_events" CASCADE;
DROP TYPE IF EXISTS "DeadLetterEventStatus";
