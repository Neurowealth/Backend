/**
 * Admin Audit Retention Worker (#682)
 *
 * Implements policy-driven lifecycle cleanup for `admin_audit_logs`.
 * While exempt from user right-to-erasure workflows, administrative audit logs
 * are retained up to `config.retention.adminAuditLogsDays` (default 365 days)
 * in accordance with data-minimization mandates (GDPR Art. 5(1)(e)).
 *
 * Guaranteed append-only at the PostgreSQL layer; deletions require:
 * 1. Legal hold inactive (`ADMIN_AUDIT_LEGAL_HOLD !== 'true'`).
 * 2. Explicit session authorization (`SET LOCAL neuro.allow_audit_retention_purge = 'true'`).
 * Expired records are cryptographically anchored to the AuditBlock hash chain before purging.
 */

export { cleanupAdminAuditLogs } from './dataRetention'
