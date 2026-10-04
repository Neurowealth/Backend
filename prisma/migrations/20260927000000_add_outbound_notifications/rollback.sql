DROP INDEX IF EXISTS "outbound_notifications_createdAt_idx";
DROP INDEX IF EXISTS "outbound_notifications_status_nextAttemptAt_idx";
DROP TABLE IF EXISTS "outbound_notifications";
DROP TYPE IF EXISTS "OutboundNotificationStatus";