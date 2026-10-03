-- Migration: 20261003_add_missing_models
-- Adds all new models required to resolve TypeScript CI errors.

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "TreasuryTier" AS ENUM ('HOT', 'WARM', 'COLD');
CREATE TYPE "CaseStatus"   AS ENUM (
  'OPEN', 'TRIAGE', 'INVESTIGATING', 'ESCALATED',
  'PENDING_SAR', 'SAR_FILED', 'CLEARED', 'CLOSED_NO_ACTION'
);

-- ── New columns on existing table ────────────────────────────────────────────

ALTER TABLE "referral_conversions"
  ADD COLUMN IF NOT EXISTS "fraudReasons"     TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "reviewDecision"   TEXT,
  ADD COLUMN IF NOT EXISTS "tier2RewardTxId"  TEXT;

-- ── AgentCircuitBreaker ───────────────────────────────────────────────────────

CREATE TABLE "agent_circuit_breakers" (
  "id"                   TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "workflowKind"         TEXT        NOT NULL,
  "status"               TEXT        NOT NULL DEFAULT 'CLOSED',
  "trippedAt"            TIMESTAMP(3),
  "trippedReason"        TEXT,
  "resetAt"              TIMESTAMP(3),
  "halfOpenSince"        TIMESTAMP(3),
  "successesInHalfOpen"  INTEGER     NOT NULL DEFAULT 0,
  "failuresInHalfOpen"   INTEGER     NOT NULL DEFAULT 0,
  "failedAt"             TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_circuit_breakers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_circuit_breakers_workflowKind_key" ON "agent_circuit_breakers"("workflowKind");
CREATE INDEX "agent_circuit_breakers_status_idx"       ON "agent_circuit_breakers"("status");
CREATE INDEX "agent_circuit_breakers_workflowKind_idx" ON "agent_circuit_breakers"("workflowKind");

-- ── ComplianceCase ────────────────────────────────────────────────────────────

CREATE TABLE "compliance_cases" (
  "id"            TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "userId"        TEXT         NOT NULL,
  "status"        "CaseStatus" NOT NULL DEFAULT 'OPEN',
  "priority"      TEXT         NOT NULL DEFAULT 'HIGH',
  "openedReason"  TEXT         NOT NULL,
  "triggerScore"  DOUBLE PRECISION,
  "relatedTxnIds" TEXT[]       NOT NULL DEFAULT '{}',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "compliance_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "compliance_cases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "compliance_cases_userId_idx"    ON "compliance_cases"("userId");
CREATE INDEX "compliance_cases_status_idx"    ON "compliance_cases"("status");
CREATE INDEX "compliance_cases_createdAt_idx" ON "compliance_cases"("createdAt");

-- ── CaseEvent ────────────────────────────────────────────────────────────────

CREATE TABLE "case_events" (
  "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "caseId"    TEXT         NOT NULL,
  "type"      TEXT         NOT NULL DEFAULT 'EVIDENCE',
  "actor"     TEXT         NOT NULL DEFAULT 'SYSTEM',
  "body"      JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "case_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "case_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "compliance_cases"("id") ON DELETE CASCADE
);
CREATE INDEX "case_events_caseId_idx"    ON "case_events"("caseId");
CREATE INDEX "case_events_createdAt_idx" ON "case_events"("createdAt");

-- ── TravelRuleRecord ──────────────────────────────────────────────────────────

CREATE TABLE "travel_rule_records" (
  "id"            TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "transactionId" TEXT         NOT NULL,
  "direction"     TEXT         NOT NULL,
  "amountBaseCcy" DECIMAL(36,18) NOT NULL,
  "baseCurrency"  TEXT         NOT NULL,
  "originator"    JSONB        NOT NULL,
  "beneficiary"   JSONB        NOT NULL,
  "dataSource"    TEXT         NOT NULL,
  "status"        TEXT         NOT NULL DEFAULT 'PENDING',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "travel_rule_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "travel_rule_records_transactionId_idx" ON "travel_rule_records"("transactionId");
CREATE INDEX "travel_rule_records_status_idx"        ON "travel_rule_records"("status");
CREATE INDEX "travel_rule_records_createdAt_idx"     ON "travel_rule_records"("createdAt");

-- ── EmailIdentity ─────────────────────────────────────────────────────────────

CREATE TABLE "email_identities" (
  "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "userId"         TEXT         NOT NULL,
  "email"          TEXT         NOT NULL,
  "verified"       BOOLEAN      NOT NULL DEFAULT FALSE,
  "verifiedAt"     TIMESTAMP(3),
  "token"          TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_identities_pkey"   PRIMARY KEY ("id"),
  CONSTRAINT "email_identities_userId_key" UNIQUE ("userId"),
  CONSTRAINT "email_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "email_identities_email_idx" ON "email_identities"("email");
CREATE INDEX "email_identities_token_idx" ON "email_identities"("token");

-- ── AlertAck ─────────────────────────────────────────────────────────────────

CREATE TABLE "alert_acks" (
  "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "ruleId"    TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "fireId"    TEXT,
  "source"    TEXT         NOT NULL,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_acks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "alert_acks_ruleId_idx"    ON "alert_acks"("ruleId");
CREATE INDEX "alert_acks_userId_idx"    ON "alert_acks"("userId");
CREATE INDEX "alert_acks_createdAt_idx" ON "alert_acks"("createdAt");

-- ── AlertFire ────────────────────────────────────────────────────────────────

CREATE TABLE "alert_fires" (
  "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "ruleId"    TEXT         NOT NULL,
  "firedAt"   TIMESTAMP(3) NOT NULL,
  "ackId"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_fires_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alert_fires_ackId_fkey" FOREIGN KEY ("ackId") REFERENCES "alert_acks"("id") ON DELETE SET NULL
);
CREATE INDEX "alert_fires_ruleId_idx"  ON "alert_fires"("ruleId");
CREATE INDEX "alert_fires_firedAt_idx" ON "alert_fires"("firedAt");

-- ── UserWebhookEndpoint ───────────────────────────────────────────────────────

CREATE TABLE "user_webhook_endpoints" (
  "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL,
  "url"       TEXT         NOT NULL,
  "secret"    TEXT         NOT NULL,
  "events"    TEXT[]       NOT NULL DEFAULT '{}',
  "isActive"  BOOLEAN      NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_webhook_endpoints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "user_webhook_endpoints_userId_idx"   ON "user_webhook_endpoints"("userId");
CREATE INDEX "user_webhook_endpoints_isActive_idx" ON "user_webhook_endpoints"("isActive");

-- ── UserWebhookDelivery ───────────────────────────────────────────────────────

CREATE TABLE "user_webhook_deliveries" (
  "id"           TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "endpointId"   TEXT         NOT NULL,
  "eventId"      TEXT         NOT NULL,
  "payload"      JSONB        NOT NULL,
  "status"       TEXT         NOT NULL DEFAULT 'PENDING',
  "responseCode" INTEGER,
  "error"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "user_webhook_endpoints"("id") ON DELETE CASCADE
);
CREATE INDEX "user_webhook_deliveries_endpointId_idx" ON "user_webhook_deliveries"("endpointId");
CREATE INDEX "user_webhook_deliveries_eventId_idx"    ON "user_webhook_deliveries"("eventId");
CREATE INDEX "user_webhook_deliveries_status_idx"     ON "user_webhook_deliveries"("status");
CREATE INDEX "user_webhook_deliveries_createdAt_idx"  ON "user_webhook_deliveries"("createdAt");

-- ── UserEvent ─────────────────────────────────────────────────────────────────

CREATE TABLE "user_events" (
  "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL,
  "seq"       BIGINT       NOT NULL,
  "topic"     TEXT         NOT NULL,
  "type"      TEXT         NOT NULL,
  "payload"   JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_events_userId_seq_idx"    ON "user_events"("userId", "seq");
CREATE INDEX "user_events_userId_topic_idx"  ON "user_events"("userId", "topic");
CREATE INDEX "user_events_createdAt_idx"     ON "user_events"("createdAt");

-- ── UserEventSequence ─────────────────────────────────────────────────────────

CREATE TABLE "user_event_sequences" (
  "userId"    TEXT         NOT NULL,
  "lastSeq"   BIGINT       NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_event_sequences_pkey" PRIMARY KEY ("userId")
);

-- ── TreasurySweepPolicy ───────────────────────────────────────────────────────

CREATE TABLE "treasury_sweep_policies" (
  "id"                    TEXT           NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "fromTier"              "TreasuryTier" NOT NULL,
  "toTier"                "TreasuryTier" NOT NULL,
  "maxHotBalance"         DECIMAL(36,18) NOT NULL,
  "sweepIntervalMinutes"  INTEGER        NOT NULL,
  "minSweepAmount"        DECIMAL(36,18) NOT NULL,
  "requiresApprovalAbove" DECIMAL(36,18),
  "version"               INTEGER        NOT NULL DEFAULT 1,
  "isActive"              BOOLEAN        NOT NULL DEFAULT TRUE,
  "createdBy"             TEXT           NOT NULL,
  "createdAt"             TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasury_sweep_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "treasury_sweep_policies_fromTier_toTier_idx" ON "treasury_sweep_policies"("fromTier", "toTier");
CREATE INDEX "treasury_sweep_policies_isActive_idx"        ON "treasury_sweep_policies"("isActive");

-- ── TreasuryAccount ───────────────────────────────────────────────────────────

CREATE TABLE "treasury_accounts" (
  "id"          TEXT           NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "publicKey"   TEXT           NOT NULL,
  "tier"        "TreasuryTier" NOT NULL,
  "isActive"    BOOLEAN        NOT NULL DEFAULT TRUE,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)   NOT NULL,
  CONSTRAINT "treasury_accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "treasury_accounts_tier_idx"     ON "treasury_accounts"("tier");
CREATE INDEX "treasury_accounts_isActive_idx" ON "treasury_accounts"("isActive");

-- ── TreasurySweep ─────────────────────────────────────────────────────────────

CREATE TABLE "treasury_sweeps" (
  "id"         TEXT           NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "fromTier"   "TreasuryTier" NOT NULL,
  "toTier"     "TreasuryTier" NOT NULL,
  "asset"      TEXT           NOT NULL,
  "amount"     DECIMAL(36,18) NOT NULL,
  "status"     TEXT           NOT NULL DEFAULT 'PENDING',
  "reason"     TEXT           NOT NULL,
  "outboxOpId" TEXT,
  "accountId"  TEXT,
  "createdAt"  TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3)   NOT NULL,
  CONSTRAINT "treasury_sweeps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "treasury_sweeps_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "treasury_accounts"("id") ON DELETE SET NULL
);
CREATE INDEX "treasury_sweeps_status_idx"           ON "treasury_sweeps"("status");
CREATE INDEX "treasury_sweeps_fromTier_toTier_idx"  ON "treasury_sweeps"("fromTier", "toTier");
CREATE INDEX "treasury_sweeps_createdAt_idx"        ON "treasury_sweeps"("createdAt");

-- ── MultisigEnvelope ──────────────────────────────────────────────────────────

CREATE TABLE "multisig_envelopes" (
  "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "sweepId"    TEXT         NOT NULL,
  "publicKey"  TEXT         NOT NULL,
  "threshold"  INTEGER      NOT NULL,
  "signatures" JSONB[]      NOT NULL DEFAULT '{}',
  "status"     TEXT         NOT NULL DEFAULT 'PENDING',
  "expiresAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "multisig_envelopes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "multisig_envelopes_sweepId_fkey" FOREIGN KEY ("sweepId") REFERENCES "treasury_sweeps"("id") ON DELETE CASCADE
);
CREATE INDEX "multisig_envelopes_sweepId_idx"   ON "multisig_envelopes"("sweepId");
CREATE INDEX "multisig_envelopes_status_idx"    ON "multisig_envelopes"("status");
CREATE INDEX "multisig_envelopes_expiresAt_idx" ON "multisig_envelopes"("expiresAt");

-- ── SignerRotation ────────────────────────────────────────────────────────────

CREATE TABLE "signer_rotations" (
  "id"                TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "treasuryAccountId" TEXT         NOT NULL,
  "oldSignerKey"      TEXT         NOT NULL,
  "newSignerKey"      TEXT         NOT NULL,
  "status"            TEXT         NOT NULL DEFAULT 'DUAL_ACTIVE',
  "dualActiveSince"   TIMESTAMP(3),
  "finalizedAt"       TIMESTAMP(3),
  "initiatedBy"       TEXT         NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "signer_rotations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signer_rotations_treasuryAccountId_fkey" FOREIGN KEY ("treasuryAccountId") REFERENCES "treasury_accounts"("id") ON DELETE CASCADE
);
CREATE INDEX "signer_rotations_treasuryAccountId_idx" ON "signer_rotations"("treasuryAccountId");
CREATE INDEX "signer_rotations_status_idx"            ON "signer_rotations"("status");
CREATE INDEX "signer_rotations_createdAt_idx"         ON "signer_rotations"("createdAt");

-- ── NotificationPreference ────────────────────────────────────────────────────

CREATE TABLE "notification_preferences" (
  "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL,
  "channel"   TEXT         NOT NULL,
  "category"  TEXT         NOT NULL,
  "enabled"   BOOLEAN      NOT NULL DEFAULT TRUE,
  "quietHours" JSONB,
  "frequency" TEXT,
  "updatedBy" TEXT         NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_preferences_userId_channel_category_key" UNIQUE ("userId", "channel", "category"),
  CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "notification_preferences_userId_idx"   ON "notification_preferences"("userId");
CREATE INDEX "notification_preferences_channel_idx"  ON "notification_preferences"("channel");
CREATE INDEX "notification_preferences_category_idx" ON "notification_preferences"("category");

-- ── NotificationPreferenceAuditLog ───────────────────────────────────────────

CREATE TABLE "notification_preference_audit_logs" (
  "id"            TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "userId"        TEXT         NOT NULL,
  "action"        TEXT         NOT NULL,
  "channel"       TEXT         NOT NULL,
  "category"      TEXT         NOT NULL,
  "previousValue" BOOLEAN      NOT NULL,
  "newValue"      BOOLEAN      NOT NULL,
  "changedBy"     TEXT         NOT NULL,
  "changedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata"      JSONB,
  CONSTRAINT "notification_preference_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_preference_audit_logs_userId_idx"    ON "notification_preference_audit_logs"("userId");
CREATE INDEX "notification_preference_audit_logs_changedAt_idx" ON "notification_preference_audit_logs"("changedAt");
