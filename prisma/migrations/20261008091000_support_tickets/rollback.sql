-- Rollback: 20261008091000_support_tickets
DROP TABLE IF EXISTS "ticket_messages";
DROP TABLE IF EXISTS "support_tickets";
DROP TYPE IF EXISTS "MessageAuthorRole";
DROP TYPE IF EXISTS "TicketPriority";
DROP TYPE IF EXISTS "TicketStatus";
DROP TYPE IF EXISTS "TicketCategory";
