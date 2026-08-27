-- Rollback for 20260618000000_add_retention_indexes
-- The forward migration used CREATE INDEX IF NOT EXISTS for four indexes, but
-- three of them (auth_nonces_expiresAt_idx, processed_events_processedAt_idx,
-- agent_logs_createdAt_idx) already existed from earlier migrations and must be
-- preserved. Only "dead_letter_events_status_createdAt_idx" was genuinely new,
-- so it is the only index this rollback removes.

DROP INDEX IF EXISTS "dead_letter_events_status_createdAt_idx";
