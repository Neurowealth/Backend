-- Rollback: 20261003_add_missing_models
-- Drops all tables/columns added in the forward migration.
-- Run BEFORE rolling back code to the prior version.

-- ── Drop new tables (in reverse dependency order) ─────────────────────────────

DROP INDEX IF EXISTS "signer_rotations_createdAt_idx";
DROP INDEX IF EXISTS "signer_rotations_status_idx";
DROP INDEX IF EXISTS "signer_rotations_treasuryAccountId_idx";
DROP INDEX IF EXISTS "multisig_envelopes_sweepId_idx";
DROP INDEX IF EXISTS "treasury_sweeps_createdAt_idx";
DROP INDEX IF EXISTS "treasury_sweeps_fromTier_toTier_idx";
DROP INDEX IF EXISTS "treasury_sweep_policies_isActive_idx";
DROP INDEX IF EXISTS "treasury_sweep_policies_fromTier_toTier_idx";
DROP INDEX IF EXISTS "user_events_userId_topic_idx";

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

-- ── Drop new columns on existing tables ───────────────────────────────────────

ALTER TABLE "referral_conversions"
  DROP COLUMN IF EXISTS "fraudReasons",
  DROP COLUMN IF EXISTS "reviewDecision",
  DROP COLUMN IF EXISTS "tier2RewardTxId";

-- ── Drop enums ────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS "CaseStatus";
