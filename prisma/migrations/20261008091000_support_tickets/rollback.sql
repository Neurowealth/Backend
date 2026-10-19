-- rollback.sql — reverse of 20261008091000_support_tickets/migration.sql
-- Remove support tickets, their messages, and migration-specific enum types.
-- WARNING: DATA LOSS — support tickets and messages are permanently removed.
-- Restore from a snapshot if this data is needed.
-- Safe to run multiple times.

DROP TABLE IF EXISTS "ticket_messages";
DROP TABLE IF EXISTS "support_tickets";

DROP TYPE IF EXISTS "MessageAuthorRole";
DROP TYPE IF EXISTS "TicketPriority";
DROP TYPE IF EXISTS "TicketStatus";
DROP TYPE IF EXISTS "TicketCategory";
