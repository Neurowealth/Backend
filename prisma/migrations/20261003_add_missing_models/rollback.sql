-- Rollback: 20261003_add_missing_models
-- Drops all tables/columns added in the forward migration.
-- Run BEFORE rolling back code to the prior version.

-- ── Drop new tables (in reverse dependency order) ─────────────────────────────

DROP INDEX IF EXISTS "user_webhook_deliveries_endpointId_createdAt_idx";
DROP INDEX IF EXISTS "webhook_deliveries_subscriptionId_status_createdAt_idx";
DROP INDEX IF EXISTS "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx";
DROP TABLE IF EXISTS "notification_preference_audit_logs";
DROP TABLE IF EXISTS "notification_preferences";
DROP TABLE IF EXISTS "user_webhook_deliveries";
DROP TABLE IF EXISTS "user_webhook_endpoints";
DROP TABLE IF EXISTS "alert_fires";
DROP TABLE IF EXISTS "alert_acks";
DROP TABLE IF EXISTS "email_identities";
DROP TABLE IF EXISTS "travel_rule_records";
DROP TABLE IF EXISTS "case_events";
DROP TABLE IF EXISTS "compliance_cases";

-- Agent circuit breakers, event stream, treasury, multisig, and signer tables
-- are owned by their original migrations and remain in place on rollback.

-- ── Drop new columns on existing tables ───────────────────────────────────────

ALTER TABLE "referral_conversions"
  DROP COLUMN IF EXISTS "fraudReasons",
  DROP COLUMN IF EXISTS "reviewDecision",
  DROP COLUMN IF EXISTS "tier2RewardTxId";

-- ── Drop enums ────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS "CaseStatus";
-- TreasuryTier is owned by 20260829223002_add_treasury_accounts and is shared
-- with treasury_sweep_policies, so this migration must not drop it.
