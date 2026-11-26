-- rollback.sql — reverse of 20261021140000_admin_audit_log_append_only/migration.sql
-- Drops append-only trigger, enforcement function, and composite index (#682).
-- WARNING: Relaxes DB-level immutability enforcement back to application-convention only.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20261021140000_admin_audit_log_append_only/rollback.sql

DROP INDEX IF EXISTS "admin_audit_logs_created_at_action_idx";
DROP TRIGGER IF EXISTS trg_admin_audit_logs_append_only ON "admin_audit_logs";
DROP FUNCTION IF EXISTS enforce_admin_audit_logs_append_only();
DROP FUNCTION IF EXISTS public.purge_admin_audit_logs(TEXT[], TIMESTAMPTZ);
DROP TABLE IF EXISTS "admin_audit_retention_control";
