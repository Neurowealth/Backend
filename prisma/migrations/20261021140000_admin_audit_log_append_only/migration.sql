-- Migration: 20261021140000_admin_audit_log_append_only (#682)
-- Enforce database-level immutability for admin_audit_logs via append-only trigger.
-- Blocks all UPDATE operations unconditionally.
-- Blocks all DELETE operations unless explicitly executed within an authorized retention session
-- (neuro.allow_audit_retention_purge = 'true') and no legal hold is active.
-- Optimizes audit log export via composite index on (createdAt DESC, action).

-- Persistent, database-controlled legal hold. The application role is not
-- granted write access to this table; a database operator controls the hold.
CREATE TABLE IF NOT EXISTS "admin_audit_retention_control" (
    "id" BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK ("id" = TRUE),
    "legalHold" BOOLEAN NOT NULL DEFAULT FALSE,
    "retentionDays" INTEGER NOT NULL DEFAULT 365 CHECK ("retentionDays" > 0),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "admin_audit_retention_control"
    ADD COLUMN IF NOT EXISTS "retentionDays" INTEGER NOT NULL DEFAULT 365 CHECK ("retentionDays" > 0);
INSERT INTO "admin_audit_retention_control" ("id", "legalHold", "retentionDays")
VALUES (TRUE, FALSE, 365)
ON CONFLICT ("id") DO NOTHING;

REVOKE ALL ON TABLE "admin_audit_retention_control" FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE "admin_audit_logs" FROM PUBLIC;

-- 1. Create or replace the append-only enforcement function
CREATE OR REPLACE FUNCTION enforce_admin_audit_logs_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'AdminAuditLog is append-only: UPDATE operations are strictly prohibited'
            USING ERRCODE = '55000';
    ELSIF TG_OP = 'DELETE' THEN
        -- Check legal hold override first
            IF current_setting('neuro.legal_hold', true) = 'true'
               OR EXISTS (
                    SELECT 1 FROM public.admin_audit_retention_control
                    WHERE id = TRUE AND "legalHold" = TRUE
               ) THEN
            RAISE EXCEPTION 'AdminAuditLog is protected by legal hold: DELETE operations are prohibited'
                USING ERRCODE = '55000';
        -- Allow deletion only if the session explicitly enables retention purging
        ELSIF current_setting('neuro.allow_audit_retention_purge', true) = 'true'
           AND current_user = (
                SELECT owner_role.rolname
                FROM pg_proc purge_proc
                JOIN pg_namespace purge_schema ON purge_schema.oid = purge_proc.pronamespace
                JOIN pg_roles owner_role ON owner_role.oid = purge_proc.proowner
                WHERE purge_schema.nspname = 'public'
                  AND purge_proc.proname = 'purge_admin_audit_logs'
                LIMIT 1
           ) THEN
            RETURN OLD;
        ELSE
            RAISE EXCEPTION 'AdminAuditLog is append-only: DELETE operations are strictly prohibited'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

-- 2. Drop existing trigger if present and attach to admin_audit_logs
DROP TRIGGER IF EXISTS trg_admin_audit_logs_append_only ON "admin_audit_logs";
CREATE TRIGGER trg_admin_audit_logs_append_only
BEFORE UPDATE OR DELETE ON "admin_audit_logs"
FOR EACH ROW
EXECUTE FUNCTION enforce_admin_audit_logs_append_only();

-- 3. Composite index for efficient export and retention cutoff queries
CREATE INDEX IF NOT EXISTS "admin_audit_logs_created_at_action_idx" ON "admin_audit_logs"("createdAt" DESC, "action");

-- The application has no direct DELETE privilege. It may call this narrow,
-- bounded retention function, which only deletes selected expired rows.
CREATE OR REPLACE FUNCTION public.purge_admin_audit_logs(
    p_ids TEXT[],
    p_cutoff TIMESTAMPTZ
)
RETURNS SETOF TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    configured_retention_days INTEGER;
    database_legal_hold BOOLEAN;
BEGIN
    IF COALESCE(cardinality(p_ids), 0) > 500 THEN
        RAISE EXCEPTION 'Admin audit retention batch exceeds 500 rows'
            USING ERRCODE = '22023';
    END IF;

    SELECT "legalHold", "retentionDays"
    INTO database_legal_hold, configured_retention_days
    FROM public.admin_audit_retention_control
    WHERE id = TRUE
    FOR SHARE;
    IF current_setting('neuro.legal_hold', true) = 'true'
       OR COALESCE(database_legal_hold, FALSE) THEN
        RAISE EXCEPTION 'AdminAuditLog is protected by legal hold: DELETE operations are prohibited'
            USING ERRCODE = '55000';
    END IF;

    IF configured_retention_days IS NULL THEN
        RAISE EXCEPTION 'Admin audit retention control row is missing'
            USING ERRCODE = '55000';
    END IF;
    IF p_cutoff > clock_timestamp() - make_interval(days => configured_retention_days) THEN
        RAISE EXCEPTION 'Admin audit purge cutoff is newer than configured retention (% days)', configured_retention_days
            USING ERRCODE = '22023';
    END IF;

    PERFORM set_config('neuro.allow_audit_retention_purge', 'true', TRUE);
    RETURN QUERY
    DELETE FROM public.admin_audit_logs
    WHERE id = ANY(p_ids) AND "createdAt" < p_cutoff
    RETURNING id;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_admin_audit_logs(TEXT[], TIMESTAMPTZ) FROM PUBLIC;

-- Production deployments use neuro_app. Keep migration usable in deployments
-- where that role is provisioned separately, and document the grant otherwise.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neuro_app') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.admin_audit_logs FROM neuro_app';
        EXECUTE 'GRANT SELECT, INSERT ON TABLE public.admin_audit_logs TO neuro_app';
        EXECUTE 'GRANT SELECT ON TABLE public.admin_audit_retention_control TO neuro_app';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.purge_admin_audit_logs(TEXT[], TIMESTAMPTZ) TO neuro_app';
    END IF;
END;
$$;
