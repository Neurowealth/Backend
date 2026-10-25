-- Rollback: 20261003_add_missing_models
-- Drops all tables/columns added in the forward migration.
-- Run BEFORE rolling back code to the prior version.

-- ── Drop new tables (in reverse dependency order) ─────────────────────────────

DROP TABLE IF EXISTS "notification_preference_audit_logs";
DROP TABLE IF EXISTS "notification_preferences";
DROP TABLE IF EXISTS "signer_rotations";
DROP TABLE IF EXISTS "multisig_envelopes";
DROP TABLE IF EXISTS "treasury_sweeps";
DROP TABLE IF EXISTS "treasury_accounts";
DROP TABLE IF EXISTS "treasury_sweep_policies";
DROP TABLE IF EXISTS "user_event_sequences";
DROP TABLE IF EXISTS "user_events";
DROP TABLE IF EXISTS "user_webhook_deliveries";
DROP TABLE IF EXISTS "user_webhook_endpoints";
DROP TABLE IF EXISTS "alert_fires";
DROP TABLE IF EXISTS "alert_acks";
DROP TABLE IF EXISTS "email_identities";
DROP TABLE IF EXISTS "travel_rule_records";
DROP TABLE IF EXISTS "case_events";
DROP TABLE IF EXISTS "compliance_cases";
DROP TABLE IF EXISTS "agent_circuit_breakers";

-- ── Drop new columns on existing tables ───────────────────────────────────────

ALTER TABLE "referral_conversions"
  DROP COLUMN IF EXISTS "fraudReasons",
  DROP COLUMN IF EXISTS "reviewDecision",
  DROP COLUMN IF EXISTS "tier2RewardTxId";

-- ── Drop enums ────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS "CaseStatus";
DROP TYPE IF EXISTS "TreasuryTier";
