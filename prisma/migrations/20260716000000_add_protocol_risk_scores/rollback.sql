-- Rollback for 20260716000000_add_protocol_risk_scores
-- Drops the protocol risk score table and the AuditStatus enum.
-- WARNING: Destroys all computed protocol risk scores (recomputable by the
-- risk scoring job after re-applying the migration).

DROP TABLE IF EXISTS "protocol_risk_scores";

DROP TYPE IF EXISTS "AuditStatus";
